// Host apply() against a fake Cordis context.
import test from 'node:test';
import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';
import { makeSession, meter, bareP, ToolResultPruner } from './helpers.mjs';

const host = await import('../src/host.js');

function fakeCtx() {
  const routes = new Map();
  const tools = [];
  const effects = [];
  const provided = {};
  const sessions = new Map();
  const listeners = new Map();
  return {
    listeners,
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    routes, toolDefs: tools, effects, liveSessions: sessions, provided,
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn) { effects.push(fn()); },
    provide(name, value) { provided[name] = value; },
    get(name) { return name === 'tokenMeter' ? meter : undefined; },
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()], messageProjections: [] },
    tools: { register(def, opts) { tools.push({ def, opts }); return () => {}; } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
  };
}
const call = async (ctx, path, body = {}) => {
  const res = await ctx.routes.get(`/api/compaction-manager/${path}`).fetch(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }));
  return res.json();
};

test('host apply wires routes, tool, and the default passthrough', async () => {
  const ctx = fakeCtx();
  const config = host.Config({});
  host.apply(ctx, config);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; for (const fn of ctx.effects) if (typeof fn === 'function') fn(); } };
  try {
  const state = await call(ctx, 'state');
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.value.integration.pruner, true);
  assert.equal(state.value.integration.basic, true);
  assert.equal(state.value.recallActive, false);
  assert.deepEqual(state.value.methods.map(m => m.id), ['trim-head-tail', 'omit-output', 'dedupe', 'drop-superseded-reads', 'purge-errors', 'fold-calls']);
  assert.deepEqual(state.value.pipeline, [{ id: 'trim', method: 'trim-head-tail', enabled: true, options: {} }]);
  assert.equal(state.value.presets.length, 4);
  const tool = ctx.toolDefs[0];
  assert.equal(tool.def.name, 'restore_context');
  assert.equal(await tool.opts.when(), false);

  // Default: pruneSession behaves exactly like the original.
  const turns = [[{ name: 'bash', args: {}, result: 'q'.repeat(20000) }], [{ name: 'bash', args: {}, result: 'ok' }]];
  const a = makeSession(turns); const b = makeSession(turns);
  const wrapped = bareP().pruneSession(a);
  dispose();
  const plain = bareP().pruneSession(b);
  assert.deepEqual(wrapped.pruned.map(p => p.charsAfter), plain.pruned.map(p => p.charsAfter));
  assert.equal(ToolResultPruner.prototype.pruneSession.name, 'pruneSession');
  } finally { dispose(); }
});

test('configured pipeline runs inside the pruner hook; preview and restore work', async () => {
  const ctx = fakeCtx();
  const config = host.Config({ pipeline: [{ method: 'official-pruner', enabled: true }, { method: 'magic-compact', enabled: true, options: { keepRecent: 0 } }] });
  host.apply(ctx, config);
  try {
    const session = makeSession([[{ name: 'bash', args: { command: 'cat big' }, result: 'w '.repeat(800) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
    ctx.liveSessions.set(session.id, session);
    const preview = await call(ctx, 'preview', { sessionId: session.id });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.ok(preview.value.afterTokens < preview.value.beforeTokens);
    const seq = session.seq;
    assert.equal(session.seq, seq);
    const tool = ctx.toolDefs[0];
    assert.equal(await tool.opts.when(), true);
    bareP().pruneSession(session);
    const notice = session.deriveMessages().find(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted'));
    assert.ok(notice, 'omission notice written (legacy magic-compact config migrated)');
    const id = /id=(r\d+)/.exec(notice.content[0].text)[1];
    const out = await tool.def.execute({ id, max_chars: 100 }, { agent: { session } });
    assert.equal(out.truncated, true);
    assert.match(out.text, /cat big/);
    const rendered = tool.def.output.render({}, out)[0].text;
    assert.match(rendered, /offset=/);
    const bad = await call(ctx, 'validate', { basic: { thresholdRatio: 2 } });
    assert.equal(bad.ok, false);
  } finally {
    for (const fn of ctx.effects) if (typeof fn === 'function') fn();
  }
});

test('compact-now queues and runs at the next pre-step inside the turn', async () => {
  const ctx = fakeCtx();
  host.apply(ctx, host.Config({ pipeline: [{ method: 'magic-compact', enabled: true, options: { keepRecent: 0 } }] }));
  try {
    const session = makeSession([[{ name: 'bash', args: { command: 'cat big' }, result: 'w '.repeat(800) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
    ctx.liveSessions.set(session.id, session);
    const queued = await call(ctx, 'compact-now', { sessionId: session.id });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    assert.ok(queued.value.queuedAt > 0);
    const before = session.seq;
    session.append('turn/start', { turn: 3 });
    let nextCalled = false;
    await ctx.listeners.get('agent/pre-step')({ agent: { session }, signal: new AbortController().signal }, async () => { nextCalled = true; return {}; });
    assert.ok(nextCalled);
    assert.ok(session.seq > before + 1, 'replacement events appended');
    const status = await call(ctx, 'session-status', { sessionId: session.id });
    assert.equal(status.value.queuedAt, null);
    assert.equal(status.value.last.applied, 1);
    // a second pre-step does nothing
    const after = session.seq;
    await ctx.listeners.get('agent/pre-step')({ agent: { session }, signal: new AbortController().signal }, async () => ({}));
    assert.equal(session.seq, after);
    // cancel path
    await call(ctx, 'compact-now', { sessionId: session.id });
    const cancelled = await call(ctx, 'compact-now', { sessionId: session.id, cancel: true });
    assert.equal(cancelled.value.queuedAt, null);
  } finally {
    for (const fn of ctx.effects) if (typeof fn === 'function') fn();
  }
});

test('preset routes validate, merge, and export user presets', async () => {
  const ctx = fakeCtx();
  const stored = [{ id: 'user-a', name: 'Mine', summary: '', steps: [{ id: 'dedupe', method: 'dedupe', enabled: true, options: {} }] }];
  host.apply(ctx, host.Config({ userPresets: stored }));
  try {
    const state = await call(ctx, 'state');
    const user = state.value.presets.filter(p => p.user);
    assert.deepEqual(user.map(p => [p.id, p.name.zh]), [['user-a', 'Mine']]);
    const saved = await call(ctx, 'presets/save', { name: 'Mine', summary: 'new', steps: [{ method: 'trim-head-tail' }] });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.value.replaced, true);
    assert.equal(saved.value.userPresets[0].id, 'user-a');
    const bad = await call(ctx, 'presets/save', { name: '', steps: [] });
    assert.equal(bad.ok, false);
    const exported = await call(ctx, 'presets/export', { ids: ['user-a'] });
    assert.equal(exported.value.presets[0].name, 'Mine');
    const imported = await call(ctx, 'presets/import', { text: JSON.stringify(exported.value) });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.deepEqual(imported.value.added.map(p => p.name), ['Mine (2)']);
    assert.equal(imported.value.userPresets.length, 2);
    const notJson = await call(ctx, 'presets/import', { text: '{oops' });
    assert.match(notJson.error, /not valid JSON/);
  } finally {
    for (const fn of ctx.effects) if (typeof fn === 'function') fn();
  }
});

test('per-session presets: own choice, inherited by subagents, deleted preset falls back', async () => {
  const { resolveSessionPipeline, cleanSessionPresets } = await import('../src/session-presets.js');
  const presets = new Map([['aggressive', { name: 'A', steps: [{ method: 'dedupe' }] }], ['mine', { name: 'M', steps: [{ method: 'omit-output' }] }]]);
  const parents = { child: 'parent', grand: 'child', parent: undefined, loopA: 'loopB', loopB: 'loopA' };
  const base = { presets, globalPipeline: [{ method: 'trim-head-tail' }], parentOf: id => parents[id] };
  const r = (id, choices) => resolveSessionPipeline(id, { ...base, choices });
  assert.equal(r('parent', {}).source, 'global');
  assert.deepEqual([r('parent', { parent: 'mine' }).source, r('parent', { parent: 'mine' }).presetId], ['session', 'mine']);
  assert.deepEqual([r('grand', { parent: 'mine' }).source, r('grand', { parent: 'mine' }).from], ['parent', 'parent']);
  assert.equal(r('child', { parent: 'mine', child: 'aggressive' }).presetId, 'aggressive', 'own choice wins over parent');
  const gone = r('child', { child: 'deleted', parent: 'mine' });
  assert.deepEqual([gone.source, gone.presetId, gone.missing.presetId], ['parent', 'mine', 'deleted']);
  assert.equal(r('parent', { parent: 'deleted' }).source, 'global');
  assert.equal(r('loopA', { x: 'mine' }).source, 'global', 'parent cycles terminate');
  assert.deepEqual(cleanSessionPresets({ a: 'mine', b: 5, c: 'Bad Id', '': 'mine' }), { a: 'mine' });

  // host wiring: preview, compaction hook and recall tool follow the session's choice
  const ctx = fakeCtx();
  const turns = [[{ name: 'bash', args: { command: 'cat big' }, result: 'w '.repeat(800) }], [{ name: 'bash', args: {}, result: 'ok' }]];
  const session = makeSession(turns);
  const other = makeSession(turns);
  Object.defineProperty(other, 'id', { value: 'other-session' });
  const userPresets = [{ id: 'user-omit', name: 'Omit all', summary: '', steps: [{ id: 'omit', method: 'omit-output', enabled: true, options: { keepRecent: 0 } }] }];
  host.apply(ctx, host.Config({ userPresets, sessionPresets: { [session.id]: 'user-omit' } }));
  try {
    ctx.liveSessions.set(session.id, session);
    ctx.liveSessions.set(other.id, other);
    const info = await call(ctx, 'session-compaction', { sessionId: session.id });
    assert.equal(info.value.choice, 'user-omit');
    assert.equal(info.value.resolution.source, 'session');
    assert.ok(info.value.presets.some(p => p.id === 'user-omit' && p.user));
    const preview = await call(ctx, 'preview', { sessionId: session.id });
    assert.equal(preview.value.resolution.presetId, 'user-omit');
    assert.equal(preview.value.steps[0].method, 'omit-output');
    const otherPreview = await call(ctx, 'preview', { sessionId: other.id });
    assert.equal(otherPreview.value.resolution.source, 'global');
    const tool = ctx.toolDefs[0];
    assert.equal(await tool.opts.when({ agent: { session } }), true);
    assert.equal(await tool.opts.when({ agent: { session: other } }), false);
    const pruner = bareP();
    pruner.pruneSession(other);
    assert.equal(other.deriveMessages().some(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted')), false, 'global default: official trim only');
    pruner.pruneSession(session);
    assert.ok(session.deriveMessages().some(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted')), 'session preset ran');
    const state = await call(ctx, 'state');
    assert.equal(state.value.sessionPresetCount, 1);
  } finally {
    for (const fn of ctx.effects) if (typeof fn === 'function') fn();
  }
});
