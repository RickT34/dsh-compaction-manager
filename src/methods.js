// Built-in atomic compaction methods. Each does one kind of change with one
// selection rule; presets (presets.js) combine them into named strategies.
import {
  RECALL_TOOL, canonicalJson, codePointLength, eligibleResults, formatChars, isCompacted, measureText,
  officialPruneContent, oneLine, parseArgs, toolLabel, toolUnits,
} from './core.js';
import { FORMATS, foldVars, noticeContent, purgeVars } from './formats.js';
import { render } from './format-runtime.js';

const t = (zh, en) => ({ zh, en });
const num = (key, label, defaultValue, extra = {}) => ({ key, type: 'number', label, default: defaultValue, ...extra });
const bool = (key, label, defaultValue, extra = {}) => ({ key, type: 'boolean', label, default: defaultValue, ...extra });
const list = (key, label, defaultValue, extra = {}) => ({ key, type: 'list', label, default: defaultValue, ...extra });
const select = (key, label, defaultValue, choices) => ({ key, type: 'select', label, default: defaultValue, choices });

export const PROTECTED_TOOLS = ['ask_user_question', 'todo_write', RECALL_TOOL];

/** Tool scope shared by every method: `tools` limits it (empty = all), `excludeTools` removes from it. */
function scopeOptions(exclude = PROTECTED_TOOLS) {
  return [
    list('tools', t('只处理这些工具（留空 = 全部）', 'Only these tools (empty = all)'), []),
    list('excludeTools', t('不处理这些工具', 'Skip these tools'), exclude),
  ];
}
function inScope(name, options) {
  const tool = name ?? '';
  if (options.excludeTools?.includes(tool)) return false;
  return !(options.tools?.length > 0) || options.tools.includes(tool);
}
function unitInScope(unit, options) {
  return unit.results.every(result => inScope(result.toolName, options) && !result.synthetic);
}

// ① Head/tail trim — the official tool-result-pruner, byte for byte.
export const trimHeadTail = {
  id: 'trim-head-tail',
  builtin: true,
  official: true,
  name: t('首尾裁剪', 'Head/tail trim'),
  summary: t(
    '超过阈值的工具结果只保留开头和结尾，中间换成固定标记。默认参数下与 DSH 自带的 tool-result-pruner 逐字节一致。',
    'Tool results over the threshold keep their head and tail with a fixed marker in between. With default options it matches the built-in tool-result-pruner byte for byte.',
  ),
  details: t(
    '来源：@deepseek-ai/dsh-compaction-tool-result-pruner。\n• 按 Unicode 码点计数，超过 thresholdChars 的结果保留前 headChars 和后 tailChars 个字符，中间替换为 “[... tool result middle pruned ...]”。\n• 处理所有工具结果，包括最近的、出错的和模型还没回应的，与官方一致。\n• 图片等非文本块原样保留；调用参数（包括 description）不受影响。\n• 默认不能取回原文；打开“附带取回 ID”后，标记里会写上 ID，模型可以用 restore_context 取回。',
    'Source: @deepseek-ai/dsh-compaction-tool-result-pruner.\n• Counts Unicode code points; results over thresholdChars keep the first headChars and last tailChars, with “[... tool result middle pruned ...]” in between.\n• Applies to every tool result, including recent, failed, and unanswered ones, as the official pruner does.\n• Non-text blocks are kept; call arguments, including the description, are untouched.\n• Not restorable by default; enable “Include recall id” to put an id in the marker for restore_context.',
  ),
  options: [
    num('thresholdChars', t('触发阈值（字符）', 'Threshold (chars)'), 8192, { min: 1 }),
    num('headChars', t('保留开头（字符）', 'Head kept (chars)'), 4096, { min: 0 }),
    num('tailChars', t('保留结尾（字符）', 'Tail kept (chars)'), 1024, { min: 0 }),
    bool('recallHint', t('附带取回 ID', 'Include recall id'), false, { hint: t('改变标记文本，使模型可取回原文', 'Changes the marker so the model can restore the original') }),
    ...scopeOptions([]),
  ],
  tagKeys: ['thresholdChars', 'tools', 'excludeTools'],
  formats: FORMATS['trim-head-tail'],
  recall: options => options.recallHint === true,
  validate(options) {
    const sample = render(options.formats.marker, { id: `r${'9'.repeat(9)}`, recall: options.recallHint, removedSize: '999.9k', removedChars: 999_999 });
    const emitted = options.headChars + codePointLength(sample) + options.tailChars;
    if (emitted > options.thresholdChars) throw new Error(`trim-head-tail: headChars + marker + tailChars (${emitted}) must be at most thresholdChars (${options.thresholdChars})`);
  },
  plan(view, options) {
    const out = [];
    for (const node of view.nodes) {
      if (node.type !== 'tool' || node.synthetic || !inScope(node.toolName, options)) continue;
      const removed = Math.max(0, measureText(node.message.content) - options.headChars - options.tailChars);
      const marker = render(options.formats.marker, { id: `r${node.rootSeq}`, recall: options.recallHint, removedSize: formatChars(removed), removedChars: removed });
      const content = officialPruneContent(node.message.content, options, marker);
      if (content === null) continue;
      out.push({ type: 'result', seq: node.seq, content, label: `${toolLabel(node)} · ${formatChars(node.chars)} chars`, reason: 'head/tail trim' });
    }
    return out;
  },
};

// ② Omit output — replace a whole old result with an omission notice.
export const omitOutput = {
  id: 'omit-output',
  builtin: true,
  name: t('省略输出', 'Omit output'),
  summary: t(
    '把较早的、超过阈值的工具结果整个换成一行省略提示（工具名、关键参数、完整 description、大小、ID），可用 restore_context 取回。',
    'Replaces older tool results over the threshold with a one-line omission notice (tool, key arguments, full description, size, id); restore_context brings the original back.',
  ),
  details: t(
    '• 结果超过 minChars 个字符，或超过 minWords 个词（0 表示不按词数判断）时省略。\n• 最近 keepRecent 个结果、模型还没回应的结果不处理；默认也跳过出错的结果。\n• 用“只处理这些工具 / 不处理这些工具”限定范围。可以添加多个这样的步骤，对不同工具用不同阈值。\n• 已被其他步骤省略过的结果会跳过。\n• 原文就在会话日志里，不额外存储。',
    '• Omits results over minChars characters, or over minWords words (0 disables the word rule).\n• The newest keepRecent results and unanswered results stay; failed results are skipped by default.\n• Limit the scope with the tool lists. Add several of these steps to use different thresholds for different tools.\n• Results another step already omitted are skipped.\n• Originals stay in the session log; nothing extra is stored.',
  ),
  options: [
    num('minChars', t('阈值（字符）', 'Threshold (chars)'), 1024, { min: 0 }),
    num('minWords', t('阈值（词，0 = 不用）', 'Threshold (words, 0 = off)'), 0, { min: 0 }),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 3, { min: 0 }),
    bool('skipErrors', t('跳过出错的结果', 'Skip failed results'), true),
    num('previewChars', t('省略提示中的开头预览（字符）', 'Head preview in notice (chars)'), 0, { min: 0, max: 2000 }),
    ...scopeOptions(),
  ],
  tagKeys: ['minChars', 'minWords', 'tools', 'excludeTools'],
  formats: FORMATS['omit-output'],
  recall: () => true,
  plan(view, options) {
    const out = [];
    for (const node of eligibleResults(view, options.keepRecent)) {
      if (!inScope(node.toolName, options) || isCompacted(node, view) || (options.skipErrors && node.isError)) continue;
      const words = options.minWords > 0 ? node.text.split(/\s+/).filter(Boolean).length : 0;
      const overChars = node.chars > options.minChars;
      const overWords = options.minWords > 0 && words > options.minWords;
      if (!overChars && !overWords) continue;
      const reason = overChars ? `omitted output over ${formatChars(options.minChars)} chars` : `omitted output over ${options.minWords} words`;
      out.push({ type: 'result', seq: node.seq, content: noticeContent(options.formats.notice, node, { reason, previewChars: options.previewChars }), label: `${toolLabel(node)} · ${formatChars(node.chars)} chars`, reason: 'omit' });
    }
    return out;
  },
};

// ③ Dedupe — older copies of an identical call.
export const dedupe = {
  id: 'dedupe',
  builtin: true,
  name: t('重复调用去重', 'Deduplicate calls'),
  summary: t(
    '工具名和参数完全相同的调用只保留最新一次的结果，旧结果换成指向最新结果的占位（保留完整 description）。',
    'For calls with the same tool and identical arguments, only the newest result stays; older ones become a placeholder pointing to it, with the full description kept.',
  ),
  details: t(
    '参考：Opencode-DCP 的 Deduplication。\n• 参数按排序后的键比较，键的顺序不同也算相同。\n• 小于 minChars 的结果不处理；最近 keepRecent 个结果不处理。\n• 占位里写明最新结果的 ID，模型可以用 restore_context 取回旧结果。',
    'Reference: Opencode-DCP Deduplication.\n• Arguments are compared with sorted keys, so key order does not matter.\n• Results under minChars and the newest keepRecent results stay.\n• The placeholder names the newest result’s id; restore_context returns the old result.',
  ),
  options: [
    num('minChars', t('最小处理体积（字符）', 'Minimum size (chars)'), 200, { min: 0 }),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 2, { min: 0 }),
    ...scopeOptions([...PROTECTED_TOOLS, 'skill', 'subagent', 'subagent_fork']),
  ],
  tagKeys: ['tools', 'excludeTools'],
  formats: FORMATS.dedupe,
  recall: () => true,
  plan(view, options) {
    const eligible = new Set(eligibleResults(view, options.keepRecent).map(node => node.seq));
    const groups = new Map();
    for (const node of view.nodes) {
      if (node.type !== 'tool' || node.synthetic || node.toolName === undefined || !inScope(node.toolName, options)) continue;
      const args = parseArgs(node.args);
      const key = `${node.toolName.toLowerCase()}\u0000${args === undefined ? node.args : canonicalJson(args)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    const out = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const newest = group[group.length - 1];
      for (const node of group.slice(0, -1)) {
        if (!eligible.has(node.seq) || isCompacted(node, view) || node.chars < options.minChars) continue;
        const newerId = `r${newest.rootSeq}`;
        out.push({ type: 'result', seq: node.seq, content: noticeContent(options.formats.notice, node, { reason: `duplicate of newer call (result id=${newerId})`, extra: { newerId } }), label: `${node.toolName} · ${formatChars(node.chars)} chars`, reason: 'dedupe' });
      }
    }
    return out;
  },
};

const PATH_KEYS = ['file_path', 'path', 'filePath'];
function pathOf(node) {
  const args = parseArgs(node.args);
  if (!args || typeof args !== 'object') return undefined;
  for (const key of PATH_KEYS) if (typeof args[key] === 'string' && args[key].length > 0) return args[key];
  return undefined;
}
function isFullRead(node) {
  const args = parseArgs(node.args) ?? {};
  return args.offset === undefined && args.limit === undefined;
}

// ④ Superseded reads — a read made stale by a later write or full read of the same path.
export const supersededReads = {
  id: 'drop-superseded-reads',
  builtin: true,
  name: t('清理被覆盖的读取', 'Drop superseded reads'),
  summary: t(
    '同一路径之后又被成功写入、编辑或完整读取时，旧的读取结果换成占位（保留完整 description）。',
    'When a path is later written, edited, or fully read again, the older read result becomes a placeholder, with the full description kept.',
  ),
  details: t(
    '参考：pi-dynamic-context-pruning 的 superseded-file-ops。\n• 读取工具和写入工具由列表决定，路径取 file_path、path 或 filePath 参数。\n• 只有之后的写入成功、或之后的读取是完整读取（不带 offset/limit）才算覆盖。\n• 小于 minChars 的结果、最近 keepRecent 个结果不处理。',
    'Reference: pi-dynamic-context-pruning superseded-file-ops.\n• Read and write tools come from the lists; the path is the file_path, path, or filePath argument.\n• Only a later successful write, or a later full read (no offset/limit), supersedes.\n• Results under minChars and the newest keepRecent results stay.',
  ),
  options: [
    list('readTools', t('读取工具', 'Read tools'), ['read']),
    list('writeTools', t('写入工具', 'Write tools'), ['write', 'edit']),
    num('minChars', t('最小处理体积（字符）', 'Minimum size (chars)'), 200, { min: 0 }),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 2, { min: 0 }),
  ],
  tagKeys: ['readTools'],
  formats: FORMATS['drop-superseded-reads'],
  recall: () => true,
  plan(view, options) {
    const eligible = new Set(eligibleResults(view, options.keepRecent).map(node => node.seq));
    const results = view.nodes.filter(node => node.type === 'tool' && !node.synthetic);
    const out = [];
    for (const [index, node] of results.entries()) {
      if (!options.readTools.includes(node.toolName ?? '') || !eligible.has(node.seq) || isCompacted(node, view) || node.chars < options.minChars) continue;
      const path = pathOf(node);
      if (path === undefined) continue;
      const later = results.slice(index + 1).find(other => !other.isError && pathOf(other) === path
        && (options.writeTools.includes(other.toolName ?? '') || (options.readTools.includes(other.toolName ?? '') && isFullRead(other))));
      if (later === undefined) continue;
      out.push({ type: 'result', seq: node.seq, content: noticeContent(options.formats.notice, node, { reason: `superseded by later ${later.toolName} of ${path}`, extra: { path, laterTool: later.toolName } }), label: `${node.toolName} ${oneLine(path, 60)}`, reason: 'superseded read' });
    }
    return out;
  },
};

// ⑤ Purge errors — fold old fully-failed call groups to their error messages.
export const purgeErrors = {
  id: 'purge-errors',
  builtin: true,
  name: t('清理出错调用', 'Purge failed calls'),
  summary: t(
    '若干回合前全部出错的一组调用，折叠成一段文字：只保留工具名、完整 description 和错误信息，去掉调用参数。',
    'A call group whose calls all failed some turns ago is folded into text keeping each tool name, full description, and error message, without the arguments.',
  ),
  details: t(
    '参考：Opencode-DCP 的 Purge Errors。\n• 调用所在回合比当前回合早 errorTurns 个以上才处理。\n• DSH 不能单独改写调用参数，所以只处理整组调用都出错的情况，整组换成一条 user 消息。\n• 错误信息最多保留 400 个字符；最近 keepRecent 个结果不处理。',
    'Reference: Opencode-DCP Purge Errors.\n• Only calls more than errorTurns turns old qualify.\n• DSH cannot rewrite arguments alone, so only groups where every call failed qualify; the group becomes one user message.\n• Error text is kept up to 400 characters; the newest keepRecent results stay.',
  ),
  options: [
    num('errorTurns', t('出错调用保留回合数', 'Turns before purging'), 4, { min: 1 }),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 2, { min: 0 }),
    ...scopeOptions(),
  ],
  tagKeys: ['errorTurns'],
  formats: FORMATS['purge-errors'],
  recall: () => true,
  plan(view, options) {
    const eligible = new Set(eligibleResults(view, options.keepRecent).map(node => node.seq));
    const out = [];
    for (const unit of toolUnits(view)) {
      if (!unitInScope(unit, options) || !unit.results.every(result => result.isError && eligible.has(result.seq))) continue;
      const turn = unit.assistant.turn;
      if (typeof turn !== 'number' || view.maxTurn - turn < options.errorTurns) continue;
      const text = render(options.formats.fold, purgeVars(unit, options.errorTurns));
      out.push({ type: 'fold', startSeq: unit.startSeq, endSeq: unit.endSeq, content: [{ type: 'text', text }], label: `${unit.results.map(toolLabel).join(', ')} (error)`, reason: 'purge errors' });
    }
    return out;
  },
};

// ⑥ Fold calls — replace a whole closed call group (input and output) with text.
export const foldCalls = {
  id: 'fold-calls',
  builtin: true,
  name: t('折叠工具调用', 'Fold tool calls'),
  summary: t(
    '较早的一组工具调用（参数和结果）超过阈值时，整组换成一段文字。保留级别可选：摘要（工具名、关键参数、状态、大小、结果开头）或仅 description。',
    'An older tool call group (arguments and results) over the threshold is replaced by text. Detail level: summary (tool, key arguments, status, size, result head) or description only.',
  ),
  details: t(
    '用于压缩调用参数（例如 write/edit 的整段文件内容、很长的命令）以及整组调用。\n• 参数加结果总长度超过 minTotalChars，或参数总长度超过 minArgsChars 时折叠；设为 0 表示不用这一条。\n• 摘要：每个调用一行，含关键参数、成功或出错、结果大小和开头一段，另起一行写完整 description。\n• 仅 description：每个调用只留工具名和完整 description，没有 description 时留关键参数的简短预览；出错的标 [error]。这是最激进的级别，模型之后只知道调用的目的。\n• assistant 在同一条消息里写的文字保留，过长时截断。最近 keepRecentGroups 组不处理。\n• DSH 不允许单独改写调用参数，折叠会把整组调用换成一条 user 消息，模型不再看到原生的 tool-call 结构，也会让推理块失效；restore_context 可以取回完整调用和结果。',
    'Compresses call arguments (whole file bodies in write/edit, long commands) and whole call groups.\n• Folds when arguments plus results exceed minTotalChars, or arguments alone exceed minArgsChars; 0 disables a rule.\n• Summary: one line per call with key arguments, success or error, result size and head, plus a line with the full description.\n• Description only: each call keeps its tool name and full description, or a short key-argument preview when it has none; failures are marked [error]. The most aggressive level: the model only knows what each call was for.\n• Assistant text in the same message is kept, truncated when long. The newest keepRecentGroups groups stay.\n• DSH cannot rewrite arguments alone, so the group becomes one user message; the model no longer sees native tool-call structure and reasoning blocks are invalidated. restore_context returns the full calls and results.',
  ),
  options: [
    select('detail', t('保留级别', 'Detail level'), 'summary', [
      { value: 'summary', label: t('摘要', 'Summary') },
      { value: 'description', label: t('仅 description', 'Description only') },
    ]),
    num('minTotalChars', t('阈值：参数 + 结果（字符，0 = 不用）', 'Threshold: arguments + results (chars, 0 = off)'), 8192, { min: 0 }),
    num('minArgsChars', t('阈值：参数（字符，0 = 不用）', 'Threshold: arguments (chars, 0 = off)'), 1024, { min: 0 }),
    num('keepRecentGroups', t('保留最近 N 组调用', 'Keep newest N groups'), 4, { min: 0 }),
    num('assistantTextChars', t('保留 assistant 文字长度', 'Assistant text kept (chars)'), 600, { min: 0 }),
    num('resultPreviewChars', t('摘要中的结果开头（字符）', 'Result head in summary (chars)'), 120, { min: 0 }),
    ...scopeOptions(),
  ],
  tagKeys: ['detail', 'minTotalChars', 'minArgsChars', 'tools', 'excludeTools'],
  formats: FORMATS['fold-calls'],
  recall: () => true,
  plan(view, options) {
    const units = toolUnits(view);
    const out = [];
    for (const unit of units.slice(0, Math.max(0, units.length - options.keepRecentGroups))) {
      if (!unitInScope(unit, options)) continue;
      const argsChars = unit.assistant.toolCalls.reduce((sum, call) => sum + codePointLength(String(call.arguments ?? '')), 0);
      const resultChars = unit.results.reduce((sum, result) => sum + result.chars, 0);
      const total = argsChars + resultChars;
      const overTotal = options.minTotalChars > 0 && total > options.minTotalChars;
      const overArgs = options.minArgsChars > 0 && argsChars > options.minArgsChars;
      if (!overTotal && !overArgs) continue;
      const description = options.detail === 'description';
      const vars = foldVars(unit, { ...options, argsMax: description ? 80 : 160 });
      const content = [{ type: 'text', text: render(description ? options.formats.description : options.formats.summary, vars) }];
      out.push({ type: 'fold', startSeq: unit.startSeq, endSeq: unit.endSeq, content, label: `${unit.results.map(toolLabel).join(', ')} · args ${formatChars(argsChars)}, results ${formatChars(resultChars)}`, reason: options.detail === 'description' ? 'description only' : 'fold' });
    }
    return out;
  },
};

export const BUILTIN_METHODS = [trimHeadTail, omitOutput, dedupe, supersededReads, purgeErrors, foldCalls];
