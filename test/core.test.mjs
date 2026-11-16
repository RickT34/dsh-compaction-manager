import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, bareP, meter, Session, SessionId, foldSurface, deriveEventMessage } from './helpers.mjs';
import { buildView, resolveOptions, normalizeCandidates, RECALL_TOOL } from '../src/core.js';
import { trimHeadTail, omitOutput, foldCalls } from '../src/methods.js';
import { BUILTIN_PRESETS, DEFAULT_PIPELINE } from '../src/presets.js';
import { applyCandidate, liveAccessor, recoverOriginal, surfaceEntries, snapshotAccessor } from '../src/session-view.js';
import { MethodRegistry, normalizePipeline } from '../src/registry.js';
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
const preset = id => BUILTIN_PRESETS.find(p => p.id === id).steps;
const withOptions = (steps, extra) => steps.map(step => ({ ...step, options: { ...step.options, ...extra } }));
const visible = s => JSON.stringify(s.deriveMessages().map(m => ({ role: m.role, content: m.content })));

test('trim-head-tail reproduces the official pruner byte for byte', () => {
  const turns = [[{ name: 'bash', args: { command: 'a' }, result: big(400) }], [{ name: 'read', args: { file_path: '/x' }, result: big(10) }], [{ name: 'bash', args: { command: 'b' }, result: '🙂'.repeat(9000) }]];
  const a = makeSession(turns);
  const b = makeSession(turns);
  const official = bareP().pruneSession(a);
  assert.ok(official.pruned.length === 2);
  const saved = applyAll(b, plan(trimHeadTail, b));
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

test('Magic Compact preset omits old bulky output, keeps recent and errors, and restore works', () => {
  const s = makeSession([
    [{ name: 'bash', args: { command: 'npm test' }, result: big(60) }],
    [{ name: 'read', args: { file_path: '/a.js' }, result: 'y'.repeat(300) }],
    [{ name: 'bash', args: { command: 'bad' }, result: big(60), error: true }],
    [{ name: 'ask_user_question', args: {}, result: big(60) }],
    [{ name: 'bash', args: { command: 'recent' }, result: big(60) }],
  ]);
  const registry = new MethodRegistry();
  const steps = withOptions(preset('magic-compact').filter(step => step.method === 'omit-output'), { keepRecent: 1 });
  const report = runPipeline({ session: s, meter, registry, pipeline: steps });
  assert.deepEqual(report.steps.map(step => [step.id, step.applied]), [['reloadable', 1], ['delegated', 0], ['other', 1]]);
  const msgs = s.deriveMessages();
  const notice = msgs.find(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted') && m.content[0].text.includes('bash'));
  assert.match(notice.content[0].text, /id=r\d+/);
  assert.match(notice.content[0].text, new RegExp(RECALL_TOOL));
  const id = /id=(r\d+)/.exec(notice.content[0].text)[1];
  const original = recoverOriginal(liveAccessor(s), id);
  assert.match(original, /npm test/);
  assert.match(original, /line 59/);
  // idempotent
  assert.equal(runPipeline({ session: s, meter, registry, pipeline: steps }).steps.reduce((n, step) => n + step.applied, 0), 0);
});

test('OpenCode DCP preset dedupes and purges failed inputs after N turns', () => {
  const turns = [
    [{ name: 'read', args: { file_path: '/a', limit: 10 }, result: 'A'.repeat(500) }],
    [{ name: 'bash', args: { command: 'boom '.repeat(100) }, result: 'Error: boom', error: true }],
    [{ name: 'read', args: { limit: 10, file_path: '/a' }, result: 'A'.repeat(500) }],
  ];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const before = s.surface.nodes.length;
  const report = runPipeline({ session: s, meter, registry: new MethodRegistry(), pipeline: preset('opencode-dcp') });
  assert.deepEqual(report.steps.map(step => [step.method, step.applied]), [['dedupe', 1], ['purge-errors', 1], ['trim-head-tail', 0]]);
  assert.equal(s.surface.nodes.length, before - 1);
  const fold = s.deriveMessages().find(m => m.role === 'user' && m.content[0].text.includes('failed tool calls'));
  assert.match(fold.content[0].text, /Error: boom/);
  assert.doesNotMatch(fold.content[0].text, /boom boom boom/);
  const id = /id=(c\d+)/.exec(fold.content[0].text)[1];
  assert.match(recoverOriginal(liveAccessor(s), id), /boom boom boom/);
});

test('fold-calls folds big write arguments and survives replay', () => {
  const turns = [[{ name: 'write', args: { file_path: '/f.js', content: 'z'.repeat(5000) }, result: 'wrote' }]];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const cands = plan(foldCalls, s);
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
  const pipeline = [{ method: 'trim-head-tail' }, { method: 'omit-output', options: { keepRecent: 0 } }, { method: 'dedupe', enabled: false }];
  const result = previewSession(surfaceEntries(liveAccessor(s)), pipeline, registry, meter.estimateMessage, bareP().config);
  assert.equal(s.seq, before);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.equal(result.steps[0].items.length, 1);
  assert.equal(result.steps[1].items.length, 2);
  assert.equal(result.steps.find(st => st.method === 'dedupe').enabled, false);
  assert.deepEqual(result.steps.map(st => st.id), ['trim-head-tail', 'omit-output', 'dedupe']);
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

const LONG_DESC = 'Run the full integration suite against the staging database and report every failing test with its stack trace';

test('every notice keeps the full description', () => {
  const turns = [
    [{ name: 'bash', args: { command: 'npm test', description: LONG_DESC }, result: big(80) }],
    [{ name: 'write', args: { file_path: '/f.js', content: 'z'.repeat(3000), description: LONG_DESC + ' (write)' }, result: 'wrote' }],
  ];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const a = makeSession(turns);
  applyAll(a, plan(omitOutput, a, { keepRecent: 0 }));
  const notice = a.deriveMessages().find(m => m.role === 'tool' && m.content[0].text.startsWith('[compacted'));
  assert.ok(notice.content[0].text.includes(`description: ${LONG_DESC}`), notice.content[0].text);
  const b = makeSession(turns);
  applyAll(b, plan(foldCalls, b));
  const fold = b.deriveMessages().find(m => m.role === 'user' && m.content[0].text.includes('original call structure folded'));
  assert.ok(fold.content[0].text.includes(`description: ${LONG_DESC} (write)`), fold.content[0].text);
});

test('fold-calls description level keeps only tool names and descriptions above the threshold', () => {
  const turns = [
    [{ name: 'bash', args: { command: 'cat huge.log', description: LONG_DESC }, result: big(200) }, { name: 'read', args: { file_path: '/secret-detail.txt' }, result: 'R'.repeat(3000), error: true }],
    [{ name: 'bash', args: { command: 'ls', description: 'list files' }, result: 'a b c' }],
  ];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const DESC = { detail: 'description', minTotalChars: 4096, minArgsChars: 0 };
  const cands = plan(foldCalls, s, DESC);
  assert.equal(cands.length, 1, 'only the large group qualifies');
  assert.ok(applyAll(s, cands) > 1000);
  const fold = s.deriveMessages().find(m => m.role === 'user' && m.content[0].text.includes('only descriptions kept'));
  const text = fold.content[0].text;
  assert.ok(text.includes(`• bash: ${LONG_DESC}`), text);
  assert.match(text, /• read\(file_path=\/secret-detail\.txt\) \[error\]/);
  assert.doesNotMatch(text, /cat huge\.log|line 199|RRRR/);
  assert.match(text, /working on 1/);
  const id = /id=(c\d+)/.exec(text)[1];
  const original = recoverOriginal(liveAccessor(s), id);
  assert.match(original, /cat huge\.log/);
  assert.match(original, /line 199/);
  // already-folded groups are not folded again, and the log replays
  assert.equal(plan(foldCalls, s, DESC).length, 0);
  const events = s.snapshotEvents();
  assert.deepEqual(foldSurface(events).nodes, [...s.surface.nodes]);
});

test('0.1.x pipelines migrate to atomic steps with unique ids', () => {
  const legacyDefault = [
    { method: 'official-pruner', enabled: true, options: {} },
    { method: 'magic-compact', enabled: false, options: {} },
    { method: 'opencode-dcp', enabled: false, options: {} },
    { method: 'fold-tool-calls', enabled: false, options: {} },
  ];
  assert.deepEqual(normalizePipeline(legacyDefault), normalizePipeline(DEFAULT_PIPELINE));
  const migrated = normalizePipeline([
    { method: 'official-pruner', enabled: true, options: { thresholdChars: 9000 } },
    { method: 'magic-compact', enabled: true, options: { keepRecent: 1, maxChars: 2000 } },
    { method: 'opencode-dcp', enabled: true, options: { supersededReads: true, purgeErrors: false } },
    { method: 'fold-tool-calls', enabled: true, options: { minResultChars: 5000 } },
  ]);
  assert.deepEqual(migrated.map(step => step.method), ['trim-head-tail', 'omit-output', 'omit-output', 'omit-output', 'dedupe', 'drop-superseded-reads', 'fold-calls']);
  assert.equal(migrated[0].options.thresholdChars, 9000);
  assert.equal(migrated[3].options.minChars, 2000);
  assert.equal(migrated[3].options.keepRecent, 1);
  assert.equal(migrated[6].options.minTotalChars, 5000);
  assert.equal(new Set(migrated.map(step => step.id)).size, migrated.length);
  const repeated = normalizePipeline([{ method: 'fold-calls' }, { method: 'fold-calls' }, { id: 'fold-calls', method: 'fold-calls' }]);
  assert.deepEqual(repeated.map(step => step.id), ['fold-calls', 'fold-calls-2', 'fold-calls-3']);
});

test('every built-in preset resolves to registered methods with valid options', () => {
  const registry = new MethodRegistry();
  const presets = registry.describePresets();
  assert.deepEqual(presets.map(p => p.id), ['official', 'magic-compact', 'opencode-dcp', 'aggressive']);
  for (const p of presets) {
    for (const step of p.steps) {
      const method = registry.get(step.method);
      assert.ok(method, `${p.id}: ${step.method}`);
      assert.doesNotThrow(() => resolveOptions(method, step.options), `${p.id}/${step.id}`);
    }
  }
  assert.throws(() => registry.registerPreset({ id: 'official', steps: [{ method: 'dedupe' }] }));
  const dispose = registry.registerPreset({ id: 'mine', name: 'Mine', steps: [{ method: 'dedupe' }] });
  assert.ok(registry.describePresets().some(p => p.id === 'mine'));
  dispose();
  assert.ok(!registry.describePresets().some(p => p.id === 'mine'));
});

test('aggressive preset summarizes large calls and keeps descriptions for large arguments', () => {
  const turns = [
    [{ name: 'bash', args: { command: 'cat huge.log', description: LONG_DESC }, result: big(200) }],
    [{ name: 'write', args: { file_path: '/w.js', content: 'q'.repeat(1500), description: 'write the helper' }, result: 'ok' }],
  ];
  for (let i = 0; i < 5; i += 1) turns.push([{ name: 'bash', args: { command: `n${i}` }, result: 'ok' }]);
  const s = makeSession(turns);
  const report = runPipeline({ session: s, meter, registry: new MethodRegistry(), pipeline: preset('aggressive') });
  assert.deepEqual(report.steps.map(step => [step.id, step.applied]), [['dedupe', 0], ['errors', 0], ['summary', 1], ['description', 1], ['trim', 0]]);
  const texts = s.deriveMessages().filter(m => m.role === 'user').map(m => m.content[0].text);
  const large = texts.find(text => text.includes('cat huge.log'));
  assert.match(large, /original call structure folded/);
  assert.ok(large.includes(`description: ${LONG_DESC}`));
  const write = texts.find(text => text.includes('only descriptions kept'));
  assert.match(write, /• write: write the helper/);
  assert.doesNotMatch(write, /qqqq/);
});

test('user presets: clean untrusted input, save, merge imports, export round trip', async () => {
  const up = await import('../src/user-presets.js');
  const registry = new MethodRegistry();
  const good = { name: '  My  preset ', summary: 'x', steps: [{ method: 'omit-output', options: { minChars: 500, tools: ['read'] } }, { method: 'trim-head-tail' }] };
  const cleaned = up.cleanPreset(good, registry);
  assert.equal(cleaned.name, 'My preset');
  assert.deepEqual(cleaned.steps.map(s => s.id), ['omit-output', 'trim-head-tail']);
  // invalid inputs
  assert.throws(() => up.cleanPreset({ name: '', steps: [{ method: 'dedupe' }] }, registry), /name/);
  assert.throws(() => up.cleanPreset({ name: 'a', steps: [] }, registry), /step/);
  assert.throws(() => up.cleanPreset({ name: 'a', steps: [{ method: 'Bad Id' }] }, registry), /method id/);
  assert.throws(() => up.cleanPreset({ name: 'a', steps: [{ method: 'trim-head-tail', options: { headChars: 9000 } }] }, registry), /thresholdChars/);
  assert.throws(() => up.cleanPreset({ name: 'a', steps: [{ method: 'dedupe', options: [] }] }, registry), /options/);
  const proto = up.cleanPreset(JSON.parse('{"name":"p","steps":[{"method":"dedupe","options":{"__proto__":{"x":1},"minChars":10}}]}'), registry);
  assert.deepEqual(proto.steps[0].options, { minChars: 10 });
  assert.equal(({}).x, undefined);
  const unknown = up.cleanPreset({ name: 'u', steps: [{ method: 'not-installed' }] }, registry);
  assert.match(unknown.warnings[0], /not installed/);
  // save: new, then same name replaces in place
  let { userPresets, replaced } = up.savePreset([], cleaned);
  assert.equal(replaced, false);
  const firstId = userPresets[0].id;
  ({ userPresets, replaced } = up.savePreset(userPresets, { ...cleaned, summary: 'changed' }));
  assert.equal(replaced, true);
  assert.equal(userPresets.length, 1);
  assert.equal(userPresets[0].id, firstId);
  // export → import keeps steps, renames duplicates, assigns new ids
  const file = JSON.parse(JSON.stringify(up.exportFile(userPresets)));
  assert.equal(file.format, up.PRESET_FILE_FORMAT);
  const parsed = up.parsePresetFile(file, registry);
  assert.equal(parsed.errors.length, 0);
  const merged = up.mergeImported(userPresets, parsed.presets);
  assert.equal(merged.userPresets.length, 2);
  assert.equal(merged.added[0].name, 'My preset (2)');
  assert.notEqual(merged.added[0].id, firstId);
  assert.deepEqual(merged.added[0].steps, userPresets[0].steps);
  // partial failures are reported, not fatal; other shapes accepted
  const mixed = up.parsePresetFile({ presets: [good, { name: 'bad' }] }, registry);
  assert.equal(mixed.presets.length, 1);
  assert.match(mixed.errors[0], /#2 \(bad\)/);
  assert.equal(up.parsePresetFile([good], registry).presets.length, 1);
  assert.equal(up.parsePresetFile(good, registry).presets.length, 1);
  assert.throws(() => up.parsePresetFile({ format: 'other', presets: [good] }, registry), /not a compaction preset file/);
  assert.throws(() => up.parsePresetFile({ version: 99, presets: [good] }, registry), /newer/);
  // stored list: malformed entries dropped, ids stable
  const stored = up.storedUserPresets([{ id: firstId, ...good }, { id: 'x', name: 'broken' }], registry);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, firstId);
});
