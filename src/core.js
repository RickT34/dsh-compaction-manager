// Pure, model-free compaction pipeline core: surface views, method plans,
// candidate simulation, and marker rendering. No Node or DSH imports, so the
// same code runs for live writes, previews, and tests.

/** Prefix shared by every marker this plugin writes; used to skip already-compacted content. */
export const MARKER_PREFIX = '[compacted';
/** Official pruner marker, byte-identical to @deepseek-ai/dsh-compaction-tool-result-pruner. */
export const OFFICIAL_PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';
/** Name of the model-facing retrieval tool. */
export const RECALL_TOOL = 'restore_context';

export function codePointLength(text) {
  return Array.from(text).length;
}

export function textOf(blocks) {
  let out = '';
  for (const block of blocks ?? []) if (block?.type === 'text') out += block.text;
  return out;
}

export function measureText(blocks) {
  let chars = 0;
  for (const block of blocks ?? []) if (block?.type === 'text') chars += codePointLength(block.text);
  return chars;
}

export function clip(text, max) {
  if (typeof text !== 'string') return '';
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`;
}

function oneLine(text, max) {
  return clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function formatChars(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Stable JSON with recursively sorted keys, used for duplicate detection. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseArgs(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

const ROLE_TYPE = { system: 'system', developer: 'developer', user: 'user', assistant: 'assistant', tool: 'tool' };

/**
 * Build a read-only view of the model-visible surface.
 * @param entries - [{ seq, rootSeq, eventType, message }] in surface order.
 */
export function buildView(entries) {
  const calls = new Map();
  const nodes = [];
  let maxTurn = 0;
  for (const [index, entry] of entries.entries()) {
    const message = entry.message;
    const type = ROLE_TYPE[message?.role] ?? 'other';
    const node = {
      index,
      seq: entry.seq,
      rootSeq: entry.rootSeq ?? entry.seq,
      eventType: entry.eventType,
      type,
      message,
      turn: entry.turn,
      synthetic: entry.synthetic === true,
      text: textOf(message?.content),
      chars: measureText(message?.content),
    };
    if (typeof entry.turn === 'number' && entry.turn > maxTurn) maxTurn = entry.turn;
    if (type === 'assistant') {
      node.toolCalls = [];
      for (const block of message.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        const call = { id: block.id, name: block.name, arguments: block.arguments ?? '', assistantSeq: entry.seq, turn: entry.turn };
        node.toolCalls.push(call);
        calls.set(block.id, call);
      }
    }
    if (type === 'tool') {
      node.callId = message.toolCallId ?? message.source?.callId;
      node.isError = message.isError === true;
    }
    nodes.push(node);
  }
  for (const node of nodes) {
    if (node.type !== 'tool') continue;
    const call = calls.get(node.callId);
    node.toolName = call?.name;
    node.args = call?.arguments ?? '';
    node.callTurn = call?.turn;
  }
  // Nodes after the last assistant message hold results the model has not answered yet.
  let lastAssistant = -1;
  for (const node of nodes) if (node.type === 'assistant') lastAssistant = node.index;
  for (const node of nodes) node.pending = node.index > lastAssistant;
  return { nodes, calls, maxTurn };
}

/** Tool-result nodes eligible for model-free methods, newest `keepRecent` results excluded. */
export function eligibleResults(view, keepRecent = 0) {
  const results = view.nodes.filter(node => node.type === 'tool' && !node.pending && !node.synthetic);
  return keepRecent > 0 ? results.slice(0, Math.max(0, results.length - keepRecent)) : results;
}

/**
 * Closed tool units: one assistant node with tool calls followed contiguously
 * by exactly its results, with no unanswered call crossing either boundary.
 */
export function toolUnits(view) {
  const units = [];
  const { nodes } = view;
  let open = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const balancedBefore = open === 0;
    if (node.type === 'assistant') open += node.toolCalls.length;
    else if (node.type === 'tool') open = Math.max(0, open - 1);
    if (node.type !== 'assistant' || node.toolCalls.length === 0 || !balancedBefore) continue;
    const ids = new Set(node.toolCalls.map(call => call.id));
    const results = [];
    let j = i + 1;
    while (j < nodes.length && nodes[j].type === 'tool' && ids.has(nodes[j].callId)) {
      results.push(nodes[j]);
      j += 1;
    }
    if (results.length !== ids.size) continue;
    if (results.some(result => result.pending)) continue;
    units.push({ assistant: node, results, startSeq: node.seq, endSeq: results[results.length - 1].seq });
  }
  return units;
}

function isCompacted(node) {
  return node.text.startsWith(MARKER_PREFIX);
}

function nonText(blocks) {
  return (blocks ?? []).filter(block => block?.type !== 'text');
}

function recallLine(id) {
  return `Call ${RECALL_TOOL} with id "${id}" to view the original.`;
}

function toolLabel(node) {
  return node.toolName ?? 'tool';
}

function argsPreview(raw, max = 160) {
  const args = parseArgs(raw);
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const keys = ['command', 'file_path', 'path', 'filePath', 'pattern', 'url', 'query', 'queries', 'description', 'id', 'name'];
    const parts = [];
    for (const key of keys) {
      if (args[key] === undefined) continue;
      parts.push(`${key}=${oneLine(typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key]), 80)}`);
      if (parts.length >= 2) break;
    }
    if (parts.length > 0) return oneLine(parts.join(', '), max);
  }
  return oneLine(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''), max);
}

/** Omission notice replacing one tool result; keeps non-text blocks. */
export function omittedResult(node, { reason, previewChars = 0 }) {
  const id = `r${node.rootSeq}`;
  const lines = node.text.split('\n').length;
  const head = `${MARKER_PREFIX} · id=${id} · ${toolLabel(node)}(${argsPreview(node.args, 120)}) · ${reason} · ${formatChars(node.chars)} chars, ${lines} lines]`;
  const preview = previewChars > 0 ? `\n${clip(node.text, previewChars)}` : '';
  return [{ type: 'text', text: `${head}${preview}\n${recallLine(id)}` }, ...nonText(node.message.content)];
}

/** Exact official head/middle/tail pruning (dsh-compaction-tool-result-pruner). */
export function officialPruneContent(blocks, { thresholdChars, headChars, tailChars }, marker = OFFICIAL_PRUNE_MARKER) {
  const totalChars = measureText(blocks);
  if (totalChars <= thresholdChars) return null;
  const removedStart = headChars;
  const removedEnd = totalChars - tailChars;
  const pruned = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of blocks) {
    if (block.type !== 'text') { pruned.push(block); continue; }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const insert = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? marker : '';
    if (insert.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + insert + points.slice(tailStart).join('');
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) return null;
  const after = measureText(pruned);
  if (after > thresholdChars || after >= totalChars) return null;
  return pruned;
}

/** Text summary of one folded tool unit. */
export function foldUnitContent(unit, { assistantTextChars = 600, resultPreviewChars = 120 } = {}) {
  const id = `c${unit.assistant.rootSeq}`;
  const lines = [`${MARKER_PREFIX} tool calls · id=${id} · ${unit.results.length} call(s); original call structure folded to save context]`];
  const said = unit.assistant.text.trim();
  if (said.length > 0) lines.push(`assistant said: ${clip(said, assistantTextChars)}`);
  for (const result of unit.results) {
    const status = result.isError ? 'error' : 'ok';
    const first = oneLine(result.text, resultPreviewChars);
    const args = String(result.args ?? '');
    lines.push(`• ${toolLabel(result)}(${argsPreview(args)}${codePointLength(args) > 160 ? `; args ${formatChars(codePointLength(args))} chars` : ''}) → ${status}, ${formatChars(result.chars)} chars${first ? `: ${first}` : ''}`);
  }
  const images = unit.results.reduce((count, result) => count + nonText(result.message.content).length, 0);
  if (images > 0) lines.push(`(${images} non-text block(s) omitted)`);
  lines.push(recallLine(id));
  return [{ type: 'text', text: lines.join('\n') }];
}

function messageWithContent(message, content) {
  return { ...message, content };
}

/**
 * Apply candidates to a view's entry list without touching a session.
 * @returns next entries plus per-candidate before/after messages.
 */
export function simulate(entries, candidates) {
  const next = [...entries];
  const applied = [];
  for (const candidate of candidates) {
    if (candidate.type === 'result') {
      const index = next.findIndex(entry => entry.seq === candidate.seq);
      if (index < 0) continue;
      const before = next[index].message;
      const after = messageWithContent(before, candidate.content);
      next[index] = { ...next[index], message: after };
      applied.push({ candidate, before: [before], after });
    } else if (candidate.type === 'fold') {
      const start = next.findIndex(entry => entry.seq === candidate.startSeq);
      const end = next.findIndex(entry => entry.seq === candidate.endSeq);
      if (start < 0 || end < start) continue;
      const before = next.slice(start, end + 1).map(entry => entry.message);
      const after = { role: 'user', content: candidate.content, source: { kind: 'compaction-manager' } };
      next.splice(start, end - start + 1, { seq: `fold:${candidate.startSeq}`, rootSeq: candidate.startSeq, eventType: 'user/message', message: after, turn: entries[start]?.turn, synthetic: true });
      applied.push({ candidate, before, after });
    }
  }
  return { entries: next, applied };
}

/** Drop overlapping or repeated candidates while preserving order. */
export function normalizeCandidates(view, candidates) {
  const touched = new Set();
  const out = [];
  const positions = new Map(view.nodes.map(node => [node.seq, node.index]));
  for (const candidate of candidates) {
    if (candidate.type === 'result') {
      if (!positions.has(candidate.seq) || touched.has(candidate.seq)) continue;
      touched.add(candidate.seq);
      out.push(candidate);
    } else if (candidate.type === 'fold') {
      const start = positions.get(candidate.startSeq);
      const end = positions.get(candidate.endSeq);
      if (start === undefined || end === undefined || end < start) continue;
      const seqs = view.nodes.slice(start, end + 1).map(node => node.seq);
      if (seqs.some(seq => touched.has(seq))) continue;
      for (const seq of seqs) touched.add(seq);
      out.push(candidate);
    }
  }
  return out;
}

// ---------------------------------------------------------------- methods

const t = (zh, en) => ({ zh, en });

function num(key, label, defaultValue, extra = {}) {
  return { key, type: 'number', label, default: defaultValue, ...extra };
}
function bool(key, label, defaultValue, extra = {}) {
  return { key, type: 'boolean', label, default: defaultValue, ...extra };
}
function list(key, label, defaultValue, extra = {}) {
  return { key, type: 'list', label, default: defaultValue, ...extra };
}

/** Resolve option values against declared defaults and bounds. */
export function resolveOptions(method, raw = {}) {
  const out = {};
  for (const option of method.options ?? []) {
    let value = raw?.[option.key];
    if (option.type === 'number') {
      value = typeof value === 'number' && Number.isFinite(value) ? value : option.default;
      if (option.integer !== false) value = Math.round(value);
      if (option.min !== undefined) value = Math.max(option.min, value);
      if (option.max !== undefined) value = Math.min(option.max, value);
    } else if (option.type === 'boolean') {
      value = typeof value === 'boolean' ? value : option.default;
    } else if (option.type === 'list') {
      value = Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length > 0) : option.default;
    } else if (option.type === 'select') {
      value = option.choices?.some(choice => choice.value === value) ? value : option.default;
    } else {
      value = typeof value === 'string' ? value : option.default;
    }
    out[option.key] = value;
  }
  if (typeof method.validate === 'function') method.validate(out);
  return out;
}

export const officialPruner = {
  id: 'official-pruner',
  builtin: true,
  official: true,
  name: t('官方：超长结果首尾裁剪', 'Official: head/tail trim of long results'),
  summary: t(
    '与 DSH 自带的 tool-result-pruner 完全相同：超过阈值的工具结果只保留开头和结尾，中间换成固定标记。',
    'Identical to the built-in tool-result-pruner: results over the threshold keep their head and tail, with a fixed marker in between.',
  ),
  details: t(
    '来源：@deepseek-ai/dsh-compaction-tool-result-pruner。\n• 按 Unicode 码点计数，超过 thresholdChars 的工具结果保留前 headChars 和后 tailChars 个字符。\n• 中间替换为 “[... tool result middle pruned ...]”。\n• 图片等非文本块原样保留。\n• 默认不提供取回入口，原文只留在会话日志里；打开“附带取回 ID”后，标记里会写上 ID，模型可以用 restore_context 取回。\n• 只在压缩触发时运行，不调用模型。',
    'Source: @deepseek-ai/dsh-compaction-tool-result-pruner.\n• Counts Unicode code points; results over thresholdChars keep the first headChars and last tailChars.\n• The middle becomes “[... tool result middle pruned ...]”.\n• Non-text blocks are kept.\n• By default nothing is retrievable; enable “Include recall id” to add an id the model can pass to restore_context.\n• Runs only when compaction triggers; no model call.',
  ),
  options: [
    num('thresholdChars', t('触发阈值（字符）', 'Threshold (chars)'), 8192, { min: 1 }),
    num('headChars', t('保留开头（字符）', 'Head kept (chars)'), 4096, { min: 0 }),
    num('tailChars', t('保留结尾（字符）', 'Tail kept (chars)'), 1024, { min: 0 }),
    bool('recallHint', t('附带取回 ID', 'Include recall id'), false, { hint: t('改变标记文本，使模型可取回原文', 'Changes the marker so the model can restore the original') }),
  ],
  recall: options => options.recallHint === true,
  validate(options) {
    const emitted = options.headChars + codePointLength(OFFICIAL_PRUNE_MARKER) + options.tailChars;
    if (emitted > options.thresholdChars) throw new Error(`official-pruner: headChars + marker + tailChars (${emitted}) must be at most thresholdChars (${options.thresholdChars})`);
  },
  plan(view, options) {
    const out = [];
    for (const node of view.nodes) {
      if (node.type !== 'tool' || node.synthetic) continue;
      const marker = options.recallHint ? `\n\n[... tool result middle pruned · ${RECALL_TOOL} id=r${node.rootSeq} ...]\n\n` : OFFICIAL_PRUNE_MARKER;
      const content = officialPruneContent(node.message.content, options, marker);
      if (content === null) continue;
      out.push({ type: 'result', seq: node.seq, content, label: `${toolLabel(node)} · ${formatChars(node.chars)} chars`, reason: 'head/tail trim' });
    }
    return out;
  },
};

const MAGIC_PRESERVE = ['ask_user_question', 'todo_write', RECALL_TOOL];
const MAGIC_ALWAYS = ['read', 'read_image', 'skill', 'web_fetch'];
const MAGIC_HIGH = ['subagent', 'subagent_fork', 'job_output', 'workflow', 'send_message'];

export const magicCompact = {
  id: 'magic-compact',
  builtin: true,
  name: t('Magic Compact：省略旧工具输出', 'Magic Compact: omit old tool output'),
  summary: t(
    '仿照 aerovato/magic-compact 的 /magic-trim：把旧的、体积大的工具输出换成带 ID 的省略提示，模型可随时用 restore_context 取回原文。',
    'Modeled on aerovato/magic-compact /magic-trim: replaces old bulky tool output with an omission notice carrying an id the model can restore.',
  ),
  details: t(
    '参考：github.com/aerovato/magic-compact（Tool I/O Rules）。\n• 普通工具：输出超过 maxChars 个字符或 maxWords 个词时省略。\n• 可重新获取的输出（read、skill、web_fetch 等）：超过 minChars 就省略，因为模型可以重新读取。\n• 子代理与任务类输出（subagent、job_output、workflow 等）：使用更高阈值 highChars。\n• 保留：ask_user_question、todo_write、出错的结果、最近 keepRecent 个结果，以及模型还没回应的结果。\n• 省略提示包含工具名、关键参数、大小，可选保留开头预览。\n• 原文就在会话日志里，不额外存储；不调用模型。\n• 与原版的差异：原版在 /magic-compact 时还会用模型总结旧 assistant 回合，这里只实现不调用模型的 trim 部分。',
    'Reference: github.com/aerovato/magic-compact (Tool I/O Rules).\n• Ordinary tools: omitted above maxChars characters or maxWords words.\n• Reloadable outputs (read, skill, web_fetch…): omitted above minChars because the model can reload them.\n• Subagent/job outputs: higher threshold highChars.\n• Preserved: ask_user_question, todo_write, errors, the newest keepRecent results, and results the model has not answered yet.\n• The notice names the tool, key arguments, size, and an optional head preview.\n• Originals stay in the session log; no model call.\n• Difference: the original also summarizes old assistant turns with a model in /magic-compact; only the model-free trim is implemented here.',
  ),
  options: [
    num('maxChars', t('普通输出阈值（字符）', 'Ordinary threshold (chars)'), 1024, { min: 1 }),
    num('maxWords', t('普通输出阈值（词）', 'Ordinary threshold (words)'), 128, { min: 1 }),
    num('highChars', t('子代理/任务输出阈值（字符）', 'Subagent/job threshold (chars)'), 4096, { min: 1 }),
    num('minChars', t('可重读输出最小体积（字符）', 'Reloadable minimum (chars)'), 200, { min: 0 }),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 3, { min: 0 }),
    num('previewChars', t('省略提示中的预览长度', 'Preview length in notice'), 0, { min: 0, max: 2000 }),
    list('alwaysTools', t('总是省略的工具', 'Always-omit tools'), MAGIC_ALWAYS),
    list('highTools', t('高阈值工具', 'High-threshold tools'), MAGIC_HIGH),
    list('preserveTools', t('不处理的工具', 'Preserved tools'), MAGIC_PRESERVE),
  ],
  recall: () => true,
  plan(view, options) {
    const out = [];
    for (const node of eligibleResults(view, options.keepRecent)) {
      const name = node.toolName ?? '';
      if (node.isError || isCompacted(node) || options.preserveTools.includes(name)) continue;
      const words = node.text.split(/\s+/).filter(Boolean).length;
      let reason;
      if (options.alwaysTools.includes(name)) {
        if (node.chars > options.minChars) reason = 'reloadable output';
      } else if (options.highTools.includes(name)) {
        if (node.chars > options.highChars) reason = 'large delegated output';
      } else if (node.chars > options.maxChars || words > options.maxWords) {
        reason = 'bulky completed output';
      }
      if (reason === undefined) continue;
      out.push({ type: 'result', seq: node.seq, content: omittedResult(node, { reason, previewChars: options.previewChars }), label: `${name || 'tool'} · ${formatChars(node.chars)} chars`, reason });
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

export const opencodeDcp = {
  id: 'opencode-dcp',
  builtin: true,
  name: t('OpenCode DCP：去重与清理出错调用', 'OpenCode DCP: dedupe and purge errors'),
  summary: t(
    '仿照 Opencode-DCP 的自动策略：重复调用只保留最新结果；出错调用在若干回合后清掉输入、保留错误信息；可选清理被后续写入覆盖的旧读取。',
    'Modeled on Opencode-DCP automatic strategies: repeated calls keep only the newest result; errored calls lose their input after some turns while keeping the error; optionally drop reads superseded by later writes.',
  ),
  details: t(
    '参考：github.com/Tarquinen/opencode-dynamic-context-pruning（Deduplication、Purge Errors），以及 pi-dynamic-context-pruning 的 superseded-file-ops。\n• 去重：工具名相同、参数在排序键后完全相同的调用，只保留最新一次的结果，旧结果换成指向它的占位。\n• 清理出错调用：出错调用比当前回合早 errorTurns 个回合以上时，把整组调用折叠为一段文字，保留错误信息，去掉调用参数。只处理整组调用都出错的情况，因为 DSH 不能单独改写参数。\n• 覆盖的读取（默认关闭）：同一路径之后有成功的 write/edit 或完整 read 时，旧 read 结果换成占位。\n• 保护：最近 keepRecent 个结果和模型还没回应的结果不处理。\n• 与原版的差异：原版另有让模型调用的 compress 工具（用模型做摘要），这里不实现。',
    'Reference: Tarquinen/opencode-dynamic-context-pruning (Deduplication, Purge Errors) and pi-dynamic-context-pruning superseded-file-ops.\n• Dedupe: calls with the same tool and canonically equal arguments keep only the newest result.\n• Purge errors: when an errored call is more than errorTurns turns old, the whole call group is folded into text that keeps the error and drops the arguments; only groups whose calls all failed qualify, because DSH cannot rewrite arguments alone.\n• Superseded reads (off by default): an older read of a path is replaced once a later successful write/edit or full read exists.\n• Protected: the newest keepRecent results and unanswered results.\n• Difference: the model-invoked compress tool (LLM summaries) is not implemented.',
  ),
  options: [
    bool('dedupe', t('去重', 'Deduplicate'), true),
    bool('purgeErrors', t('清理出错调用的输入', 'Purge errored inputs'), true),
    num('errorTurns', t('出错调用保留回合数', 'Turns before purging errors'), 4, { min: 1 }),
    bool('supersededReads', t('清理被覆盖的读取', 'Drop superseded reads'), false),
    num('keepRecent', t('保留最近 N 个结果', 'Keep newest N results'), 2, { min: 0 }),
    num('minChars', t('最小处理体积（字符）', 'Minimum size (chars)'), 200, { min: 0 }),
    list('protectedTools', t('不处理的工具', 'Protected tools'), ['ask_user_question', 'todo_write', 'skill', 'subagent', 'subagent_fork', RECALL_TOOL]),
  ],
  recall: () => true,
  plan(view, options) {
    const out = [];
    const eligible = eligibleResults(view, options.keepRecent).filter(node => !options.protectedTools.includes(node.toolName ?? ''));
    const eligibleSeqs = new Set(eligible.map(node => node.seq));
    if (options.dedupe) {
      const groups = new Map();
      for (const node of view.nodes) {
        if (node.type !== 'tool' || node.synthetic || node.toolName === undefined) continue;
        const args = parseArgs(node.args);
        const key = `${node.toolName.toLowerCase()}\u0000${args === undefined ? node.args : canonicalJson(args)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const newest = group[group.length - 1];
        for (const node of group.slice(0, -1)) {
          if (!eligibleSeqs.has(node.seq) || isCompacted(node) || node.chars < options.minChars) continue;
          out.push({ type: 'result', seq: node.seq, content: omittedResult(node, { reason: `duplicate of newer call (result id=r${newest.rootSeq})` }), label: `${node.toolName} · ${formatChars(node.chars)} chars`, reason: 'dedupe' });
        }
      }
    }
    if (options.supersededReads) {
      const resultNodes = view.nodes.filter(node => node.type === 'tool' && !node.synthetic);
      for (const [index, node] of resultNodes.entries()) {
        if (node.toolName !== 'read' || !eligibleSeqs.has(node.seq) || isCompacted(node) || node.chars < options.minChars) continue;
        const path = pathOf(node);
        if (path === undefined) continue;
        const later = resultNodes.slice(index + 1).find(other => !other.isError && pathOf(other) === path
          && (other.toolName === 'write' || other.toolName === 'edit' || (other.toolName === 'read' && isFullRead(other))));
        if (later === undefined) continue;
        out.push({ type: 'result', seq: node.seq, content: omittedResult(node, { reason: `superseded by later ${later.toolName} of ${path}` }), label: `read ${oneLine(path, 60)}`, reason: 'superseded read' });
      }
    }
    if (options.purgeErrors) {
      for (const unit of toolUnits(view)) {
        if (!unit.results.every(result => result.isError && eligibleSeqs.has(result.seq))) continue;
        const turn = unit.assistant.turn;
        if (typeof turn !== 'number' || view.maxTurn - turn < options.errorTurns) continue;
        const id = `c${unit.assistant.rootSeq}`;
        const lines = [`${MARKER_PREFIX} errored tool calls · id=${id} · inputs purged after ${options.errorTurns} turns]`];
        for (const result of unit.results) lines.push(`• ${toolLabel(result)} failed: ${clip(result.text.trim(), 400)}`);
        lines.push(recallLine(id));
        out.push({ type: 'fold', startSeq: unit.startSeq, endSeq: unit.endSeq, content: [{ type: 'text', text: lines.join('\n') }], label: `${unit.results.map(toolLabel).join(', ')} (error)`, reason: 'purge errors' });
      }
    }
    return out;
  },
};

export const foldToolCalls = {
  id: 'fold-tool-calls',
  builtin: true,
  name: t('折叠旧工具调用（含参数）', 'Fold old tool calls (incl. arguments)'),
  summary: t(
    '把较早的“工具调用 + 结果”整组折叠成一段文字摘要（工具名、关键参数、状态、大小、ID），连同调用参数一起省掉。',
    'Folds older tool call groups (call plus results) into one text summary with tool names, key arguments, status, size and id, removing the call arguments too.',
  ),
  details: t(
    '本插件新增的方法，用于压缩工具调用参数（例如 write/edit 的整段文件内容、很长的 bash 命令）。\n• DSH 不允许单独改写 assistant 消息里的调用参数，只能把一整组已闭合的调用和结果替换成一条 user 消息。\n• 折叠后模型不再看到原生的 tool-call 结构，只看到文字摘要；需要时用 restore_context 取回完整的调用和结果。\n• 只折叠参数总长度超过 minArgsChars，或结果总长度超过 minResultChars 的组；最近 keepRecentGroups 组不处理。\n• assistant 在同一条消息里写的文字会保留，过长时截断。\n• 默认关闭：改变历史结构可能影响部分模型的行为，也会让推理块失效。',
    'Added by this plugin to compress tool-call arguments (whole file bodies in write/edit, long bash commands).\n• DSH cannot rewrite arguments inside an assistant message alone; it can only replace a closed call group with one user message.\n• After folding the model sees text instead of native tool-call structure; restore_context returns the full calls and results.\n• Only groups whose arguments exceed minArgsChars or whose results exceed minResultChars are folded; the newest keepRecentGroups groups are untouched.\n• Assistant text in the same message is kept, truncated when long.\n• Off by default: changing history structure can affect some models and invalidates reasoning blocks.',
  ),
  options: [
    num('minArgsChars', t('参数总长度阈值（字符）', 'Arguments threshold (chars)'), 1024, { min: 0 }),
    num('minResultChars', t('结果总长度阈值（字符）', 'Results threshold (chars)'), 8192, { min: 0 }),
    num('keepRecentGroups', t('保留最近 N 组调用', 'Keep newest N groups'), 4, { min: 0 }),
    num('assistantTextChars', t('保留 assistant 文字长度', 'Assistant text kept (chars)'), 600, { min: 0 }),
    list('protectedTools', t('含这些工具的组不折叠', 'Groups with these tools stay'), ['ask_user_question', 'todo_write', RECALL_TOOL]),
  ],
  recall: () => true,
  plan(view, options) {
    const units = toolUnits(view);
    const candidates = units.slice(0, Math.max(0, units.length - options.keepRecentGroups));
    const out = [];
    for (const unit of candidates) {
      if (unit.results.some(result => options.protectedTools.includes(result.toolName ?? '') || result.synthetic)) continue;
      const argsChars = unit.assistant.toolCalls.reduce((sum, call) => sum + codePointLength(String(call.arguments ?? '')), 0);
      const resultChars = unit.results.reduce((sum, result) => sum + result.chars, 0);
      if (argsChars <= options.minArgsChars && resultChars <= options.minResultChars) continue;
      out.push({ type: 'fold', startSeq: unit.startSeq, endSeq: unit.endSeq, content: foldUnitContent(unit, options), label: `${unit.results.map(toolLabel).join(', ')} · args ${formatChars(argsChars)}, results ${formatChars(resultChars)}`, reason: 'fold' });
    }
    return out;
  },
};

export const BUILTIN_METHODS = [officialPruner, magicCompact, opencodeDcp, foldToolCalls];

/** Default pipeline: exactly the official behavior (official pruner only). */
export const DEFAULT_PIPELINE = [
  { method: 'official-pruner', enabled: true, options: {} },
  { method: 'magic-compact', enabled: false, options: {} },
  { method: 'opencode-dcp', enabled: false, options: {} },
  { method: 'fold-tool-calls', enabled: false, options: {} },
];

/**
 * Plan and simulate a whole pipeline over surface entries.
 * @param entries - surface entries from a session snapshot.
 * @param steps - [{ method, enabled, options }] resolved against `methods`.
 * @param methods - Map of method id to definition.
 * @param estimate - message token estimator.
 */
export function previewPipeline(entries, steps, methods, estimate) {
  let current = entries;
  const total = list => list.reduce((sum, entry) => sum + estimate(entry.message), 0);
  const beforeTokens = total(current);
  const reports = [];
  for (const step of steps) {
    const method = methods.get(step.method);
    if (method === undefined) { reports.push({ method: step.method, enabled: step.enabled, missing: true, items: [], savedTokens: 0 }); continue; }
    if (!step.enabled) { reports.push({ method: step.method, enabled: false, items: [], savedTokens: 0 }); continue; }
    let options;
    try { options = resolveOptions(method, step.options); } catch (error) {
      reports.push({ method: step.method, enabled: true, error: String(error?.message ?? error), items: [], savedTokens: 0 });
      continue;
    }
    const view = buildView(current);
    const candidates = normalizeCandidates(view, method.plan(view, options) ?? []);
    const { entries: next, applied } = simulate(current, candidates);
    const items = applied.map(({ candidate, before, after }) => {
      const beforeTokensItem = before.reduce((sum, message) => sum + estimate(message), 0);
      const afterTokensItem = estimate(after);
      return {
        kind: candidate.type,
        label: candidate.label ?? '',
        reason: candidate.reason ?? '',
        beforeTokens: beforeTokensItem,
        afterTokens: afterTokensItem,
        before: before.map(message => renderMessage(message)).join('\n\n'),
        after: renderMessage(after),
      };
    });
    reports.push({ method: step.method, enabled: true, items, savedTokens: items.reduce((sum, item) => sum + item.beforeTokens - item.afterTokens, 0) });
    current = next;
  }
  return { beforeTokens, afterTokens: total(current), steps: reports };
}

/** Human-readable rendering of one message for previews. */
export function renderMessage(message) {
  const parts = [];
  for (const block of message?.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool-call') parts.push(`→ ${block.name}(${block.arguments ?? ''})`);
    else if (block.type === 'reasoning') parts.push(`[reasoning ${formatChars(codePointLength(block.text ?? ''))} chars]`);
    else parts.push(`[${block.type}]`);
  }
  return `${message?.role ?? '?'}: ${parts.join('\n')}`;
}
