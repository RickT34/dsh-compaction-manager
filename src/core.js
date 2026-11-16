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

export function oneLine(text, max) {
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

export function isCompacted(node) {
  return node.text.startsWith(MARKER_PREFIX);
}

export function nonText(blocks) {
  return (blocks ?? []).filter(block => block?.type !== 'text');
}

export function recallLine(id) {
  return `Call ${RECALL_TOOL} with id "${id}" to view the original.`;
}

export function toolLabel(node) {
  return node.toolName ?? 'tool';
}

/**
 * The call's `description` argument, whitespace-collapsed but never truncated:
 * it is the caller's own statement of intent, so every notice keeps all of it.
 */
export function descriptionOf(raw) {
  const args = parseArgs(raw);
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.description !== 'string') return undefined;
  const text = args.description.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

/** Short preview of the key arguments, excluding `description` (shown in full separately). */
export function argsPreview(raw, max = 160) {
  const args = parseArgs(raw);
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const keys = ['command', 'file_path', 'path', 'filePath', 'pattern', 'url', 'query', 'queries', 'id', 'name'];
    const parts = [];
    for (const key of keys) {
      if (args[key] === undefined) continue;
      parts.push(`${key}=${oneLine(typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key]), 80)}`);
      if (parts.length >= 2) break;
    }
    if (parts.length > 0) return oneLine(parts.join(', '), max);
    const { description: _description, ...rest } = args;
    return Object.keys(rest).length === 0 ? '' : oneLine(JSON.stringify(rest), max);
  }
  return oneLine(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''), max);
}

/** `name(key args)` followed by the full description when the call has one. */
export function callLabel(name, raw, max = 160) {
  const description = descriptionOf(raw);
  return `${name}(${argsPreview(raw, max)})${description === undefined ? '' : ` · description: ${description}`}`;
}

/** Omission notice replacing one tool result; keeps non-text blocks. */
export function omittedResult(node, { reason, previewChars = 0 }) {
  const id = `r${node.rootSeq}`;
  const lines = node.text.split('\n').length;
  const head = `${MARKER_PREFIX} · id=${id} · ${callLabel(toolLabel(node), node.args, 120)} · ${reason} · ${formatChars(node.chars)} chars, ${lines} lines]`;
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
    const description = descriptionOf(args);
    lines.push(`• ${toolLabel(result)}(${argsPreview(args)}${codePointLength(args) > 160 ? `; args ${formatChars(codePointLength(args))} chars` : ''}) → ${status}, ${formatChars(result.chars)} chars${first ? `: ${first}` : ''}`);
    if (description !== undefined) lines.push(`  description: ${description}`);
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

// ---------------------------------------------------------------- options

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

/**
 * Plan and simulate a whole pipeline over surface entries.
 * @param entries - surface entries from a session snapshot.
 * @param steps - [{ id, method, enabled, options }] resolved against `methods`.
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
    const base = { id: step.id ?? step.method, method: step.method, options: step.options ?? {} };
    if (method === undefined) { reports.push({ ...base, enabled: step.enabled, missing: true, items: [], savedTokens: 0 }); continue; }
    if (!step.enabled) { reports.push({ ...base, enabled: false, items: [], savedTokens: 0 }); continue; }
    let options;
    try { options = resolveOptions(method, step.options); } catch (error) {
      reports.push({ ...base, enabled: true, error: String(error?.message ?? error), items: [], savedTokens: 0 });
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
    reports.push({ ...base, enabled: true, items, savedTokens: items.reduce((sum, item) => sum + item.beforeTokens - item.afterTokens, 0) });
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
