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
  return {
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
  assert.deepEqual(state.value.methods.map(m => m.id), ['official-pruner', 'magic-compact', 'opencode-dcp', 'fold-tool-calls']);
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
    assert.ok(notice, 'magic-compact notice written');
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
