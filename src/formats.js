// Text formats for compaction output. Each built-in method declares one or
// more formats: a default template, the variables it receives, and sample
// values for the editor's live preview. The defaults reproduce the text the
// methods wrote before formats were configurable, byte for byte.
import { staticPrefix, TEMPLATE_MAX } from './template.js';
import { cleanFormats, render } from './format-runtime.js';
import { MARKER_PREFIX, argsPreview, clip, codePointLength, descriptionOf, formatChars, nonText, oneLine, toolLabel } from './core.js';

const t = (zh, en) => ({ zh, en });
const v = (name, zh, en) => ({ name, description: t(zh, en) });

export const NOTICE_TEMPLATE = '[compacted · id={{id}} · {{tool}}({{args}}){{#description}} · description: {{description}}{{/description}} · {{reason}} · {{size}} chars, {{lines}} lines]{{#preview}}\n{{preview}}{{/preview}}\nCall restore_context with id "{{id}}" to view the original.';
export const TRIM_MARKER_TEMPLATE = '\n\n[... tool result middle pruned{{#recall}} · restore_context id={{id}}{{/recall}} ...]\n\n';
export const PURGE_TEMPLATE = '[compacted failed tool calls · id={{id}} · inputs purged after {{turns}} turns]\n{{#calls}}• {{tool}}{{#description}} (description: {{description}}){{/description}} failed: {{error}}\n{{/calls}}Call restore_context with id "{{id}}" to view the original.';
export const SUMMARY_TEMPLATE = '[compacted tool calls · id={{id}} · {{count}} call(s); original call structure folded to save context]\n{{#assistant}}assistant said: {{assistant}}\n{{/assistant}}{{#calls}}• {{tool}}({{args}}{{#bigArgs}}; args {{argsSize}} chars{{/bigArgs}}) → {{status}}, {{size}} chars{{#head}}: {{head}}{{/head}}\n{{#description}}  description: {{description}}\n{{/description}}{{/calls}}{{#images}}({{images}} non-text block(s) omitted)\n{{/images}}Call restore_context with id "{{id}}" to view the original.';
export const DESCRIPTION_TEMPLATE = '[compacted tool calls · id={{id}} · {{count}} call(s), {{totalSize}} chars; only descriptions kept]\n{{#assistant}}assistant said: {{assistant}}\n{{/assistant}}{{#calls}}• {{tool}}{{^description}}({{args}}){{/description}}{{#isError}} [error]{{/isError}}{{#description}}: {{description}}{{/description}}\n{{/calls}}Call restore_context with id "{{id}}" to view the original.';

// ---------------------------------------------------------------- variables

const NOTICE_VARS = [
  v('id', '取回 ID，例如 r123；restore_context 用它取回原文', 'Recall id such as r123; restore_context takes it'),
  v('tool', '工具名', 'Tool name'),
  v('args', '关键参数的简短预览（约 120 字符，不含 description）', 'Short preview of key arguments (about 120 chars, without description)'),
  v('argsFull', '完整调用参数（JSON，可能很长，建议加 |clip:N）', 'Full call arguments as JSON (may be long; consider |clip:N)'),
  v('description', '调用时写的 description，完整保留；没有时为空', 'The call’s description in full; empty when absent'),
  v('reason', '隐藏的原因', 'Why the result was hidden'),
  v('size', '原结果大小，例如 5.2k', 'Original size, such as 5.2k'),
  v('chars', '原结果字符数', 'Original length in characters'),
  v('lines', '原结果行数', 'Original line count'),
  v('preview', '结果开头（长度由“开头预览”参数决定，为 0 时为空）', 'Result head (length from the head preview option; empty at 0)'),
  v('result', '完整原结果（可能很长，建议加 |clip:N 或 |lines:N）', 'Full original result (may be long; consider |clip:N or |lines:N)'),
  v('isError', '结果是否出错', 'Whether the result is an error'),
];

const CALL_VARS = [
  v('tool', '工具名', 'Tool name'),
  v('args', '关键参数的简短预览（不含 description）', 'Short preview of key arguments (without description)'),
  v('argsFull', '完整调用参数（JSON，可能很长）', 'Full call arguments as JSON (may be long)'),
  v('argsSize', '参数大小，例如 3.1k', 'Argument size, such as 3.1k'),
  v('argsChars', '参数字符数', 'Argument length in characters'),
  v('bigArgs', '参数是否超过 160 字符', 'Whether the arguments exceed 160 chars'),
  v('description', '调用时写的 description，完整保留；没有时为空', 'The call’s description in full; empty when absent'),
  v('status', 'ok 或 error', 'ok or error'),
  v('isError', '结果是否出错', 'Whether the result is an error'),
  v('size', '结果大小', 'Result size'),
  v('chars', '结果字符数', 'Result length in characters'),
  v('lines', '结果行数', 'Result line count'),
  v('head', '结果开头一行（长度由“结果开头”参数决定）', 'Result head on one line (length from the result head option)'),
  v('result', '完整结果（可能很长，建议加 |clip:N 或 |lines:N）', 'Full result (may be long; consider |clip:N or |lines:N)'),
];

const FOLD_VARS = [
  v('id', '取回 ID，例如 c123；restore_context 用它取回整组调用', 'Recall id such as c123; restore_context returns the whole group'),
  v('count', '这一组的调用数', 'Number of calls in the group'),
  v('assistant', 'assistant 在同一条消息里写的文字（按参数截断）；没有时为空', 'Assistant text in the same message (truncated by the option); empty when absent'),
  v('calls', '调用列表，用 {{#calls}}…{{/calls}} 逐个输出，里面可用下面带 · 的变量', 'List of calls; repeat with {{#calls}}…{{/calls}} and use the · variables inside'),
  ...CALL_VARS.map(item => ({ ...item, name: item.name, item: true })),
  v('totalSize', '参数加结果的总大小', 'Arguments plus results, formatted'),
  v('totalChars', '参数加结果的总字符数', 'Arguments plus results in characters'),
  v('images', '被省略的图片等非文本块数量', 'Number of omitted non-text blocks such as images'),
];

const PURGE_VARS = [
  v('id', '取回 ID，例如 c123', 'Recall id such as c123'),
  v('turns', '“出错调用保留回合数”参数', 'The turns-before-purging option'),
  v('count', '这一组的调用数', 'Number of calls in the group'),
  v('calls', '调用列表，用 {{#calls}}…{{/calls}} 逐个输出', 'List of calls; repeat with {{#calls}}…{{/calls}}'),
  { ...v('tool', '工具名', 'Tool name'), item: true },
  { ...v('description', '调用时写的 description，完整保留', 'The call’s description in full'), item: true },
  { ...v('error', '错误信息（最多 400 字符）', 'Error message (up to 400 chars)'), item: true },
  { ...v('result', '完整错误输出', 'Full error output'), item: true },
  { ...v('args', '关键参数的简短预览', 'Short preview of key arguments'), item: true },
  { ...v('argsFull', '完整调用参数（JSON）', 'Full call arguments as JSON'), item: true },
];

const TRIM_VARS = [
  v('id', '取回 ID，例如 r123', 'Recall id such as r123'),
  v('recall', '是否打开了“附带取回 ID”', 'Whether “Include recall id” is on'),
  v('removedSize', '被裁掉的中间部分大小', 'Size of the removed middle'),
  v('removedChars', '被裁掉的字符数', 'Removed characters'),
];

// ---------------------------------------------------------------- samples

const SAMPLE_RESULT = '> dsh-compaction-manager@0.2.0 test\n> node --test test/*.test.mjs\n\n✔ trim-head-tail reproduces the official pruner byte for byte (11ms)\n✔ default pipeline delegates to the original pruner (2ms)\n✖ fold-calls folds big write arguments (4ms)\n  AssertionError: expected 1 candidate, got 0\nℹ tests 19\nℹ pass 18\nℹ fail 1';
const SAMPLE_CALL = {
  tool: 'bash', args: 'command=npm test', argsFull: '{"command":"npm test","description":"Run the unit tests"}', argsSize: '57', argsChars: 57, bigArgs: false,
  description: 'Run the unit tests', status: 'error', isError: true, size: '5.2k', chars: 5210, lines: 11, head: '> dsh-compaction-manager@0.2.0 test > node --test test/*.test.mjs ✔ trim-head-tail reproduces the of…', result: SAMPLE_RESULT,
};
const SAMPLE_WRITE = {
  tool: 'write', args: 'file_path=src/template.js', argsFull: '{"file_path":"src/template.js","content":"// Logic-less templates for compaction text…"}', argsSize: '8.4k', argsChars: 8412, bigArgs: true,
  description: '', status: 'ok', isError: false, size: '74', chars: 74, lines: 1, head: 'Created file /home/user/project/src/template.js', result: 'Created file /home/user/project/src/template.js',
};
const SAMPLE_NOTICE = {
  id: 'r123', tool: 'bash', args: 'command=npm test', argsFull: SAMPLE_CALL.argsFull, description: 'Run the unit tests',
  size: '5.2k', chars: 5210, lines: 11, preview: '', result: SAMPLE_RESULT, isError: false,
};
const SAMPLE_FOLD = {
  id: 'c456', count: 2, assistant: 'The template engine is next; writing it and running the tests.',
  calls: [SAMPLE_WRITE, SAMPLE_CALL], totalSize: '13.7k', totalChars: 13753, images: 0,
};

// ---------------------------------------------------------------- descriptors

function noticeFormat(reasonSample, extraVars = [], extraSample = {}) {
  return {
    key: 'notice',
    label: t('省略提示', 'Notice'),
    default: NOTICE_TEMPLATE,
    marker: true,
    vars: [...NOTICE_VARS, ...extraVars],
    sample: { ...SAMPLE_NOTICE, reason: reasonSample, ...extraSample },
  };
}

export const FORMATS = {
  'trim-head-tail': [{
    key: 'marker',
    label: t('中间标记', 'Middle marker'),
    default: TRIM_MARKER_TEMPLATE,
    vars: TRIM_VARS,
    sample: { id: 'r123', recall: true, removedSize: '3.1k', removedChars: 3072 },
  }],
  'omit-output': [noticeFormat('omitted output over 1.0k chars')],
  dedupe: [noticeFormat('duplicate of newer call (result id=r456)', [v('newerId', '最新一次调用结果的 ID', 'Id of the newest result')], { newerId: 'r456' })],
  'drop-superseded-reads': [noticeFormat('superseded by later write of src/core.js', [
    v('path', '文件路径', 'File path'),
    v('laterTool', '覆盖它的工具（write、edit 或 read）', 'The later tool (write, edit or read)'),
  ], { tool: 'read', args: 'file_path=src/core.js', argsFull: '{"file_path":"src/core.js"}', description: '', path: 'src/core.js', laterTool: 'write' })],
  'purge-errors': [{
    key: 'fold',
    label: t('折叠文字', 'Folded text'),
    default: PURGE_TEMPLATE,
    vars: PURGE_VARS,
    sample: { id: 'c789', turns: 4, count: 1, calls: [{ tool: 'bash', description: 'Run the unit tests', error: 'Error: Cannot find module \'./template.js\'', result: 'Error: Cannot find module \'./template.js\'\n    at resolve (node:internal/modules/esm/resolve:263:11)', args: 'command=npm test', argsFull: SAMPLE_CALL.argsFull }] },
  }],
  'fold-calls': [
    { key: 'summary', label: t('摘要', 'Summary'), default: SUMMARY_TEMPLATE, vars: FOLD_VARS, sample: SAMPLE_FOLD },
    { key: 'description', label: t('仅 description', 'Description only'), default: DESCRIPTION_TEMPLATE, vars: FOLD_VARS, sample: { ...SAMPLE_FOLD, calls: [{ ...SAMPLE_WRITE, args: 'file_path=src/template.js' }, SAMPLE_CALL] } },
  ],
};

// ---------------------------------------------------------------- resolution and rendering

/** Literal prefixes identifying result text that a step already compacted. */
export function compactedMarkers(steps, registry) {
  const markers = new Set([MARKER_PREFIX]);
  for (const step of steps) {
    const method = registry.get(step.method);
    for (const format of method?.formats ?? []) {
      if (!format.marker) continue;
      const source = cleanFormats(step.formats)[format.key] ?? format.default;
      const prefix = staticPrefix(source);
      if (prefix.trim().length >= 3) markers.add(prefix);
    }
  }
  return [...markers];
}

export { TEMPLATE_MAX };

// ---------------------------------------------------------------- variable builders

/** Variables for a notice replacing one tool result. */
export function noticeVars(node, { reason, previewChars = 0, extra = {} }) {
  const description = descriptionOf(node.args);
  return {
    id: `r${node.rootSeq}`,
    tool: toolLabel(node),
    args: argsPreview(node.args, 120),
    argsFull: String(node.args ?? ''),
    description: description ?? '',
    reason,
    size: formatChars(node.chars),
    chars: node.chars,
    lines: node.text.split('\n').length,
    preview: previewChars > 0 ? clip(node.text, previewChars) : '',
    result: node.text,
    isError: node.isError === true,
    ...extra,
  };
}

/** Notice content: the rendered text plus the result's non-text blocks. */
export function noticeContent(template, node, options) {
  return [{ type: 'text', text: render(template, noticeVars(node, options)) }, ...nonText(node.message.content)];
}

function callVars(result, { argsMax = 160, resultPreviewChars = 120 } = {}) {
  const args = String(result.args ?? '');
  const argsChars = codePointLength(args);
  const description = descriptionOf(args);
  return {
    tool: toolLabel(result),
    args: argsPreview(args, argsMax),
    argsFull: args,
    argsSize: formatChars(argsChars),
    argsChars,
    bigArgs: argsChars > 160,
    description: description ?? '',
    status: result.isError ? 'error' : 'ok',
    isError: result.isError === true,
    size: formatChars(result.chars),
    chars: result.chars,
    lines: result.text.split('\n').length,
    head: oneLine(result.text, resultPreviewChars),
    result: result.text,
  };
}

/** Variables for a folded tool call group. */
export function foldVars(unit, { assistantTextChars = 600, resultPreviewChars = 120, argsMax = 160 } = {}) {
  const calls = unit.results.map(result => callVars(result, { argsMax, resultPreviewChars }));
  const argsChars = unit.assistant.toolCalls.reduce((sum, call) => sum + codePointLength(String(call.arguments ?? '')), 0);
  const resultChars = unit.results.reduce((sum, result) => sum + result.chars, 0);
  const said = unit.assistant.text.trim();
  return {
    id: `c${unit.assistant.rootSeq}`,
    count: unit.results.length,
    assistant: said.length > 0 ? clip(said, assistantTextChars) : '',
    calls,
    totalSize: formatChars(argsChars + resultChars),
    totalChars: argsChars + resultChars,
    images: unit.results.reduce((count, result) => count + nonText(result.message.content).length, 0),
  };
}

/** Variables for a purged group of failed calls. */
export function purgeVars(unit, turns) {
  return {
    id: `c${unit.assistant.rootSeq}`,
    turns,
    count: unit.results.length,
    calls: unit.results.map(result => ({
      tool: toolLabel(result),
      description: descriptionOf(result.args) ?? '',
      error: clip(result.text.trim(), 400),
      result: result.text,
      args: argsPreview(result.args, 160),
      argsFull: String(result.args ?? ''),
    })),
  };
}

/** JSON-safe descriptors for the panel. */
export function describeFormats(method) {
  return (method.formats ?? []).map(format => ({
    key: format.key,
    label: format.label,
    default: format.default,
    marker: format.marker === true,
    vars: (format.vars ?? []).map(item => ({ name: item.name, item: item.item === true, description: item.description })),
    sample: format.sample ?? {},
  }));
}
