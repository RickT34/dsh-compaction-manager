// Custom LLM summary prompt: the bundled official copy, preset storage, and the
// request rewrite through compaction-basic's real summarize() path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meter } from './helpers.mjs';

const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
const host = await import('../src/host.js');
const { OFFICIAL_SUMMARY_PROMPT, cleanSummaryPrompt, rewriteSummaryRequest } = await import('../src/summary-prompt.js');

function fakeCtx() {
  const routes = new Map();
  const effects = [];
  const listeners = new Map();
  const sessions = new Map();
  return {
    listeners, routes, effects, liveSessions: sessions,
    on(name, fn, options) { listeners.set(name, { fn, options }); return () => listeners.delete(name); },
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn) { effects.push(fn()); },
    provide() {},
    get(name) { return name === 'tokenMeter' ? meter : undefined; },
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()], messageProjections: [] },
    tools: { register() { return () => {}; } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
  };
}
const call = async (ctx, path, body = {}) => {
  const res = await ctx.routes.get(`/api/compaction-manager/${path}`).fetch(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }));
  return res.json();
};
const dispose = ctx => { for (const fn of ctx.effects) if (typeof fn === 'function') fn(); };

const engineConfig = {
  thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, summarizationProvider: '', summarizationModel: '',
  maxTokens: 1000, compactionRetries: 1, maxOverflowRetries: 1, modelPolicies: [], auto: true,
};

/**
 * A compaction-basic engine whose LLM runs the `llm/stream` listener (when
 * given) like the Cordis waterfall does, then records what reaches the adapter.
 */
function engineWith(listener) {
  const sent = [];
  const engine = Object.create(BasicCompactionEngine.prototype);
  engine.config = engineConfig;
  engine.ctx = {
    llm: {
      stream(options) {
        const adapter = async function* () {
          sent.push({ purpose: options.purpose, sessionId: options.sessionId, messages: options.messages });
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'summary' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        };
        return listener ? listener(options, () => adapter()) : adapter();
      },
    },
  };
  return { engine, sent };
}
const agentFor = sessionId => ({
  options: { provider: 'p', model: 'm' },
  session: { id: sessionId, requestHeader: () => undefined, toolHistory: () => [], header: {} },
});
const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const lastText = record => record.messages.at(-1).content[0].text;

test('the bundled official prompt matches the installed compaction-basic', async () => {
  const { engine, sent } = engineWith();
  const result = await engine.summarize(input, agentFor('s'));
  assert.equal(result.summary[0].text, 'summary');
  assert.equal(sent[0].purpose, 'compaction');
  assert.equal(lastText(sent[0]), OFFICIAL_SUMMARY_PROMPT);
});

test('cleanSummaryPrompt: blank or official means official; bad input is rejected', () => {
  assert.equal(cleanSummaryPrompt(undefined), undefined);
  assert.equal(cleanSummaryPrompt('  \n'), undefined);
  assert.equal(cleanSummaryPrompt(`${OFFICIAL_SUMMARY_PROMPT}\n`), undefined);
  assert.equal(cleanSummaryPrompt('用中文写摘要\r\n'), '用中文写摘要\n');
  assert.throws(() => cleanSummaryPrompt(5), /must be text/);
  assert.throws(() => cleanSummaryPrompt('x'.repeat(20001)), /longer than/);
  // Outside a marked summarize() call nothing is rewritten.
  const options = { purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] };
  assert.equal(rewriteSummaryRequest(options), false);
  assert.equal(options.messages[0].content[0].text, 'a');
});

test('the summary prompt follows the session preset, its parent, or the global setting', async () => {
  const ctx = fakeCtx();
  const userPresets = [
    { id: 'user-zh', name: '中文', summary: '', steps: [{ id: 'trim', method: 'trim-head-tail', enabled: true, options: {} }], summaryPrompt: '用中文写检查点，保留 <compacted-summary> 合并规则。' },
    { id: 'user-plain', name: 'Plain', summary: '', steps: [{ id: 'dedupe', method: 'dedupe', enabled: true, options: {} }] },
  ];
  host.apply(ctx, host.Config({ summaryPrompt: 'GLOBAL PROMPT', userPresets, sessionPresets: { a: 'user-zh', b: 'user-plain', c: 'aggressive' } }));
  try {
    ctx.liveSessions.set('child', { id: 'child', header: { parentSession: 'a' } });
    const registered = ctx.listeners.get('llm/stream');
    assert.deepEqual(registered.options, { global: true, prepend: true });
    const { engine, sent } = engineWith(registered.fn);
    for (const id of ['a', 'child', 'b', 'c', 'other']) await engine.summarize(input, agentFor(id));
    assert.deepEqual(sent.map(lastText), [
      userPresets[0].summaryPrompt, // own preset
      userPresets[0].summaryPrompt, // subagent inherits its parent's preset
      OFFICIAL_SUMMARY_PROMPT, // user preset without a prompt
      OFFICIAL_SUMMARY_PROMPT, // built-in preset
      'GLOBAL PROMPT', // global steps use the global prompt
    ]);
    assert.equal(sent[0].messages[0].content[0].text, 'hello', 'replayed prefix untouched');

    // Requests that are not compaction-basic summaries pass through.
    const plain = { purpose: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    let reached;
    registered.fn(plain, () => { reached = plain.messages; return []; });
    assert.equal(reached[0].content[0].text, 'hi');

    const state = await call(ctx, 'state');
    assert.equal(state.value.summaryPrompt, 'GLOBAL PROMPT');
    assert.equal(state.value.officialSummaryPrompt, OFFICIAL_SUMMARY_PROMPT);
    assert.equal(state.value.presets.find(p => p.id === 'user-zh').summaryPrompt, userPresets[0].summaryPrompt);
    assert.equal(state.value.presets.find(p => p.id === 'aggressive').summaryPrompt, undefined);
    const info = await call(ctx, 'session-compaction', { sessionId: 'a' });
    assert.equal(info.value.resolution.summaryPrompt, 'custom');
    assert.equal(info.value.presets.find(p => p.id === 'user-zh').customPrompt, true);
    const bad = await call(ctx, 'validate', { summaryPrompt: 7 });
    assert.equal(bad.ok, false);
  } finally { dispose(ctx); }

  // After disposal summarize is the original again.
  const { engine, sent } = engineWith();
  await engine.summarize(input, agentFor('a'));
  assert.equal(lastText(sent[0]), OFFICIAL_SUMMARY_PROMPT);
});

test('presets save, export, and import their summary prompt', async () => {
  const ctx = fakeCtx();
  host.apply(ctx, host.Config({}));
  let stored;
  try {
    const steps = [{ method: 'trim-head-tail' }];
    const saved = await call(ctx, 'presets/save', { name: 'Zh', steps, summaryPrompt: 'Chinese please' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.value.userPresets[0].summaryPrompt, 'Chinese please');
    const official = await call(ctx, 'presets/save', { name: 'Off', steps, summaryPrompt: OFFICIAL_SUMMARY_PROMPT });
    assert.equal('summaryPrompt' in official.value.userPresets[0], false, 'the official text is not stored');
    stored = saved.value.userPresets;
  } finally { dispose(ctx); }

  // Stored presets keep their prompt through the config schema.
  const ctx2 = fakeCtx();
  host.apply(ctx2, host.Config({ userPresets: stored }));
  try {
    const exported = await call(ctx2, 'presets/export', {});
    assert.equal(exported.value.presets[0].summaryPrompt, 'Chinese please');
    const imported = await call(ctx2, 'presets/import', { text: JSON.stringify(exported.value) });
    assert.equal(imported.value.userPresets[1].summaryPrompt, 'Chinese please');
  } finally { dispose(ctx2); }
});
