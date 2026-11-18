import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, renderTemplate, templateNames, staticPrefix, TemplateError, TEMPLATE_MAX } from '../src/template.js';
import { makeSession, meter } from './helpers.mjs';
import { buildView, normalizeCandidates, resolveOptions } from '../src/core.js';
import { liveAccessor, surfaceEntries } from '../src/session-view.js';
import { MethodRegistry } from '../src/registry.js';
import { runPipeline, previewSession } from '../src/pipeline.js';
import { FORMATS } from '../src/formats.js';
import { cleanPreset } from '../src/user-presets.js';

test('template engine: variables, filters, sections, inverted sections', () => {
  const vars = { name: 'bash', n: 0, long: 'a b\n  c d e f', list: [{ x: 1 }, { x: 2 }], empty: [], flag: true, nested: { inner: 'deep' } };
  assert.equal(renderTemplate('{{name}}:{{missing}}:{{n}}', vars), 'bash::0');
  assert.equal(renderTemplate('{{long|oneline}}|{{long|oneline:5}}|{{long|clip:3}}|{{long|lines:1}}|{{ long | trim }}', vars), 'a b c d e f|a b c…|a b…|a b\n…|a b\n  c d e f');
  assert.equal(renderTemplate('{{#list}}[{{x}}{{name}}]{{/list}}{{#empty}}E{{/empty}}{{^empty}}none{{/empty}}', vars), '[1bash][2bash]none');
  assert.equal(renderTemplate('{{#flag}}yes{{/flag}}{{^n}} zero{{/n}}{{#nested}} {{inner}}{{/nested}}{{! comment }}', vars), 'yes zero deep');
  assert.equal(renderTemplate('{{nested}}{{list}}', vars), '', 'objects and lists render as empty text');
  assert.equal(renderTemplate('{{constructor}}{{__proto__}}{{toString}}', {}), '', 'no prototype lookups');
  assert.deepEqual([...templateNames('{{a}}{{#b}}{{c|clip:2}}{{/b}}{{^d}}{{/d}}')], ['a', 'b', 'c', 'd']);
  assert.equal(staticPrefix('[x · {{id}}]'), '[x · ');
  assert.equal(staticPrefix('{{id}}'), '');
});

test('template engine: errors carry a code and a line', () => {
  const code = source => { try { parseTemplate(source); return null; } catch (error) { assert.ok(error instanceof TemplateError); return [error.code, error.detail.line]; } };
  assert.deepEqual(code('a\n{{id'), ['unclosed-tag', 2]);
  assert.deepEqual(code('{{#a}}x'), ['unclosed-section', 1]);
  assert.deepEqual(code('{{#a}}{{/b}}'), ['mismatch', 1]);
  assert.deepEqual(code('{{/a}}'), ['stray-close', 1]);
  assert.deepEqual(code('{{a b}}'), ['bad-name', 1]);
  assert.deepEqual(code('{{a|nope}}'), ['bad-filter', 1]);
  assert.deepEqual(code('{{a|clip}}'), ['filter-arg', 1]);
  assert.deepEqual(code('{{a|clip:x}}'), ['filter-arg', 1]);
  assert.equal(code('x'.repeat(TEMPLATE_MAX + 1))[0], 'too-long');
  assert.equal(code('{{#a}}'.repeat(9) + '{{/a}}'.repeat(9))[0], 'too-deep');
  assert.throws(() => renderTemplate('{{#l}}{{big}}{{/l}}', { l: Array(30).fill({}), big: 'x'.repeat(10000) }), /longer than/);
});

test('every default format sample renders and every default parses', () => {
  for (const [method, formats] of Object.entries(FORMATS)) {
    for (const format of formats) {
      const text = renderTemplate(format.default, format.sample);
      assert.ok(text.length > 0, `${method}/${format.key}`);
      const names = templateNames(format.default);
      const declared = new Set(format.vars.map(item => item.name));
      for (const name of names) assert.ok(declared.has(name), `${method}/${format.key} documents ${name}`);
    }
  }
});

const big = n => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');

test('custom formats change the written text, keep restore ids, and are not compacted twice', () => {
  const s = makeSession([
    [{ name: 'bash', args: { command: 'npm test', description: 'Run the tests' }, result: big(60) }],
    [{ name: 'bash', args: { command: 'ls' }, result: 'ok' }],
  ]);
  const registry = new MethodRegistry();
  const pipeline = [{ method: 'omit-output', options: { keepRecent: 0, minChars: 500 }, formats: { notice: '⟪hidden {{id}}⟫ {{description}} — {{result|lines:2}}' } }];
  const first = runPipeline({ session: s, meter, registry, pipeline });
  assert.equal(first.steps[0].applied, 1);
  const notice = s.deriveMessages().find(m => m.role === 'tool' && m.content[0].text.startsWith('⟪hidden'));
  assert.match(notice.content[0].text, /^⟪hidden r\d+⟫ Run the tests — line 0 x+\nline 1 x+\n…$/);
  // the static prefix "⟪hidden " marks it as compacted, even at a threshold it still exceeds
  const again = runPipeline({ session: s, meter, registry, pipeline: [{ ...pipeline[0], options: { keepRecent: 0, minChars: 10 } }] });
  assert.equal(again.steps[0].applied, 0);
});

test('a custom format that would grow the text is skipped live and in previews', () => {
  const s = makeSession([[{ name: 'bash', args: { command: 'x' }, result: big(30) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
  const registry = new MethodRegistry();
  const pipeline = [{ method: 'omit-output', options: { keepRecent: 0, minChars: 100 }, formats: { notice: '{{result}}{{result}}' } }];
  const preview = previewSession(surfaceEntries(liveAccessor(s)), pipeline, registry, meter.estimateMessage, undefined);
  assert.equal(preview.steps[0].items.length, 0);
  assert.equal(runPipeline({ session: s, meter, registry, pipeline }).steps[0].applied, 0);
});

test('custom trim marker disables the official passthrough and is validated', () => {
  const registry = new MethodRegistry();
  const trim = registry.get('trim-head-tail');
  assert.throws(() => resolveOptions(trim, { thresholdChars: 100, headChars: 40, tailChars: 40 }, { marker: 'x'.repeat(50) }), /at most thresholdChars/);
  assert.throws(() => resolveOptions(trim, {}, { marker: '{{#oops}}' }), /format "marker"/);
  const s = makeSession([[{ name: 'bash', args: {}, result: 'q'.repeat(20000) }], [{ name: 'bash', args: {}, result: 'ok' }]]);
  let official = 0;
  const report = runPipeline({ session: s, meter, registry, pipeline: [{ method: 'trim-head-tail', formats: { marker: '\n[cut {{removedSize}}]\n' } }], prunerConfig: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }, runOfficial: () => { official += 1; return { pruned: [] }; } });
  assert.equal(official, 0);
  assert.equal(report.steps[0].applied, 1);
  assert.match(s.deriveMessages().find(m => m.role === 'tool').content[0].text, /\n\[cut 14\.9k\]\n/);
});

test('presets keep only overriding formats and reject bad templates', () => {
  const registry = new MethodRegistry();
  const notice = FORMATS['omit-output'][0].default;
  const kept = cleanPreset({ name: 'p', steps: [{ method: 'omit-output', formats: { notice: 'mine {{id}}' } }, { method: 'omit-output', formats: { notice } }] }, registry);
  assert.deepEqual(kept.steps[0].formats, { notice: 'mine {{id}}' });
  assert.equal(kept.steps[1].formats, undefined, 'a format equal to the default is not stored');
  assert.throws(() => cleanPreset({ name: 'p', steps: [{ method: 'omit-output', formats: { notice: '{{#x}}' } }] }, registry), /never closed/);
  assert.throws(() => cleanPreset({ name: 'p', steps: [{ method: 'omit-output', formats: { notice: 5 } }] }, registry), /must be text/);
  const warned = cleanPreset({ name: 'p', steps: [{ method: 'omit-output', formats: { other: 'x' } }] }, registry);
  assert.match(warned.warnings[0], /not used/);
});
