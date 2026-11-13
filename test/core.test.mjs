import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, bareP, meter, Session, SessionId, foldSurface, deriveEventMessage } from './helpers.mjs';
import { buildView, magicCompact, opencodeDcp, foldToolCalls, officialPruner, resolveOptions, normalizeCandidates, DEFAULT_PIPELINE, RECALL_TOOL } from '../src/core.js';
import { applyCandidate, liveAccessor, recoverOriginal, surfaceEntries, snapshotAccessor } from '../src/session-view.js';
import { MethodRegistry } from '../src/registry.js';
import { runPipeline, previewSession, recallActive } from '../src/pipeline.js';
import { installIntegration } from '../src/integration.js';

const big = n => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');

function plan(method, session, raw = {}) {
  const view = buildView(surfaceEntries(liveAccessor(session)));
  return normalizeCandidates(view, method.plan(view, resolveOptions(method, raw)));
}
function applyAll(session, candidates) {
  let saved = 0;
  for (const c of candidates) saved += applyCandidate(session, meter, c);
  return saved;
}
const visible = s => JSON.stringify(s.deriveMessages().map(m => ({ role: m.role, content: m.content })));

test('official-pruner method reproduces the official pruner byte for byte', () => {
  const turns = [[{ name: 'bash', args: { command: 'a' }, result: big(400) }], [{ name: 'read', args: { file_path: '/x' }, result: big(10) }], [{ name: 'bash', args: { command: 'b' }, result: '🙂'.repeat(9000) }]];
  const a = makeSession(turns);
  const b = makeSession(turns);
  const official = bareP().pruneSession(a);
  assert.ok(official.pruned.length === 2);
  const saved = applyAll(b, plan(officialPruner, b));
  assert.ok(saved > 0);
  assert.equal(visible(b), visible(a));
});

test('default pipeline delegates to the original pruner', () => {
  const s = makeSession([[{ name: 'bash', args: {}, result: big(400) }]]);
  const registry = new MethodRegistry();
  let called = 0;
  const report = runPipeline({ session: s, meter, registry, pipeline: DEFAULT_PIPELINE, prunerConfig: bareP().config, runOfficial: x => { called += 1; return bareP().pruneSession(x); } });
  assert.equal(called, 1);
  assert.equal(report.pruned.length, 1);
  assert.equal(recallActive(DEFAULT_PIPELINE, registry, 'auto'), false);
});

test('magic-compact omits old bulky output, keeps recent and errors, and restore works', () => {
  const s = makeSession([
    [{ name: 'bash', args: { command: 'npm test' }, result: big(60) }],
    [{ name: 'read', args: { file_path: '/a.js' }, result: 'y'.repeat(300) }],
    [{ name: 'bash', args: { command: 'bad' }, result: big(60), error: true }],
    [{ name: 'ask_user_question', args: {}, result: big(60) }],
    [{ name: 'bash', args: { command: 'recent' }, result: big(60) }],
  ]);
  const cands = plan(magicCompact, s, { keepRecent: 1 });
  const labels = cands.map(c => c.label);
  assert.equal(cands.length, 2, labels.join('|'));
  applyAll(s, cands);
  const msgs = s.deriveMessages();
  const notice = msgs.find(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted'));
  assert.match(notice.content[0].text, /id=r\d+/);
  assert.match(notice.content[0].text, new RegExp(RECALL_TOOL));
  const id = /id=(r\d+)/.exec(notice.content[0].text)[1];
  const original = recoverOriginal(liveAccessor(s), id);
  assert.match(original, /npm test/);
  assert.match(original, /line 59/);
  // idempotent
  assert.equal(plan(magicCompact, s, { keepRecent: 1 }).length, 0);
});

test('opencode-dcp dedupes and purges errored inputs after N turns', () => {
  const turns = [
    [{ name: 'read', args: { file_path: '/a', limit: 10 }, result: 'A'.repeat(500) }],
    [{ name: 'bash', args: { command: 'boom '.repeat(100) }, result: 'Error: boom', error: true }],
    [{ name: 'read', args: { limit: 10, file_path: '/a' }, result: 'A'.repeat(500) }],
  ];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const cands = plan(opencodeDcp, s);
  assert.deepEqual(cands.map(c => c.reason).sort(), ['dedupe', 'purge errors']);
  const before = s.surface.nodes.length;
  applyAll(s, cands);
  assert.equal(s.surface.nodes.length, before - 1);
  const fold = s.deriveMessages().find(m => m.role === 'user' && m.content[0].text.includes('errored tool calls'));
  assert.match(fold.content[0].text, /Error: boom/);
  assert.doesNotMatch(fold.content[0].text, /boom boom boom/);
  const id = /id=(c\d+)/.exec(fold.content[0].text)[1];
  assert.match(recoverOriginal(liveAccessor(s), id), /boom boom boom/);
});

test('fold-tool-calls folds big write arguments and survives replay', () => {
  const turns = [[{ name: 'write', args: { file_path: '/f.js', content: 'z'.repeat(5000) }, result: 'wrote' }]];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const cands = plan(foldToolCalls, s);
  assert.equal(cands.length, 1);
  assert.ok(applyAll(s, cands) > 1000);
  const text = JSON.stringify(s.deriveMessages());
  assert.doesNotMatch(text, /zzzzzzzzzz/);
  assert.match(text, /write\(file_path=\/f\.js/);
  // the whole log must refold cleanly
  const events = s.snapshotEvents();
  const fold = foldSurface(events);
  assert.deepEqual(fold.nodes, [...s.surface.nodes]);
  const restored = Session.create(SessionId('copy'), events);
  assert.equal(visible(restored), visible(s));
  // recall from a detached snapshot
  const access = snapshotAccessor(events, fold, deriveEventMessage);
  const id = /id=(c\d+)/.exec(text)[1];
  assert.match(recoverOriginal(access, id), /zzzz/);
});

test('preview does not mutate and reports savings per step', () => {
  const s = makeSession([[{ name: 'bash', args: {}, result: big(400) }], [{ name: 'bash', args: {}, result: big(100) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
  const before = s.seq;
  const registry = new MethodRegistry();
  const pipeline = [{ method: 'official-pruner', enabled: true, options: {} }, { method: 'magic-compact', enabled: true, options: { keepRecent: 0 } }];
  const result = previewSession(surfaceEntries(liveAccessor(s)), pipeline, registry, meter.estimateMessage, bareP().config);
  assert.equal(s.seq, before);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.equal(result.steps[0].items.length, 1);
  assert.equal(result.steps[1].items.length, 2);
  assert.equal(result.steps.find(st => st.method === 'opencode-dcp').enabled, false);
});

test('extension methods register, plan, and unregister', () => {
  const registry = new MethodRegistry();
  const dispose = registry.register({ id: 'drop-all', name: 'Drop', options: [], recall: () => true, plan: view => view.nodes.filter(n => n.type === 'tool' && !n.pending).map(n => ({ type: 'result', seq: n.seq, content: [{ type: 'text', text: '[compacted · gone]' }] })) });
  assert.throws(() => registry.register({ id: 'drop-all', plan() {} }));
  const s = makeSession([[{ name: 'bash', args: {}, result: big(20) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
  const report = runPipeline({ session: s, meter, registry, pipeline: [{ method: 'drop-all', enabled: true, options: {} }], logger: console });
  assert.equal(report.steps[0].applied, 1);
  assert.equal(recallActive([{ method: 'drop-all', enabled: true }], registry, 'auto'), true);
  dispose();
  assert.equal(registry.get('drop-all'), undefined);
});

test('integration wraps and restores official prototypes', async () => {
  class P { pruneSession() { return 'orig'; } }
  class B {
    constructor() { this.config = Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16, headroomTokens: 65536, maxTokens: 65536 }); }
    async compactIfNeeded() { return this.config.thresholdRatio; }
    async compactPressure() { return this.config.thresholdRatio; }
    async summarize() { return this.config.summarizationModel; }
    compactNow() { return this.config.thresholdRatio; }
  }
  let overrides = {};
  const stats = { prunerCalls: 0, basicEngines: new Map() };
  const handle = installIntegration({ pruner: P, basic: B }, { logger: console, stats, basicOverrides: () => overrides, runPipeline: (self, s, orig) => orig.call(self, s) + '+wrapped' });
  assert.equal(new P().pruneSession(), 'orig+wrapped');
  const engine = new B();
  const originalConfig = engine.config;
  assert.equal(await engine.compactIfNeeded(), 0.8);
  assert.equal(engine.config, originalConfig, 'no overrides leaves config identical');
  overrides = { thresholdRatio: 0.5 };
  assert.equal(await engine.compactIfNeeded(), 0.5);
  overrides = { auto: false };
  assert.equal(await engine.compactIfNeeded(), null);
  assert.equal(engine.config, originalConfig);
  assert.throws(() => installIntegration({ pruner: P }, { logger: console, stats, basicOverrides: () => ({}), runPipeline() {} }));
  handle.dispose();
  assert.equal(new P().pruneSession(), 'orig');
  overrides = { thresholdRatio: 0.5 };
  assert.equal(await engine.compactIfNeeded(), 0.8);
});
