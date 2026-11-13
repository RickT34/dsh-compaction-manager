// Session adapters: read a live Session (or a detached log snapshot) into core
// entries, apply planned candidates as replay-safe surface replacements, and
// recover originals for restore_context.
import { randomUUID } from 'node:crypto';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Uniform read access over a live Session or a detached event array.
 * @returns { nodes, eventAt(seq), message(event), length }
 */
export function liveAccessor(session) {
  return {
    nodes: [...session.surface.nodes],
    eventAt: seq => session.eventAt(seq),
    message: event => session.deriveEventMessage(event),
    length: session.seq,
  };
}

/**
 * @param events - complete contiguous log starting at seq 0.
 * @param fold - result of dsh-session foldSurface(events, projections).
 * @param derive - dsh-session deriveEventMessage.
 */
export function snapshotAccessor(events, fold, derive) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  return {
    nodes: [...fold.nodes],
    eventAt: seq => bySeq.get(seq),
    message: event => derive(event, fold.projectedMessages),
    length: events.length,
  };
}

/** Follow single-source tool/result replacements back to the appended original. */
export function rootSeqOf(access, event) {
  let current = event;
  for (let guard = 0; guard < 64; guard += 1) {
    if (current.type !== 'tool/result' || current.surfaceOp === 'append') return current.seq;
    const sources = current.sourceEventSeqs;
    if (!Array.isArray(sources) || sources.length !== 1) return current.seq;
    const previous = access.eventAt(sources[0]);
    if (previous === undefined || previous.type !== 'tool/result') return current.seq;
    current = previous;
  }
  return current.seq;
}

/** Surface entries in model-visible order, with turn numbers and root identities. */
export function surfaceEntries(access) {
  const entries = [];
  let turn;
  for (const seq of access.nodes) {
    const event = access.eventAt(seq);
    if (event === undefined) continue;
    const message = access.message(event);
    if (message === null || message === undefined) continue;
    if (typeof event.data?.turn === 'number') turn = event.data.turn;
    entries.push({
      seq,
      rootSeq: rootSeqOf(access, event),
      eventType: event.type,
      message,
      turn,
      synthetic: event.type === 'user/message' && event.surfaceOp !== 'append',
    });
  }
  return entries;
}

/**
 * Apply one candidate to a live session. Every replacement is immediately
 * preceded by its `compaction/prune` shadow price, as the official pruner does.
 * @returns saved heuristic tokens, or 0 when the candidate no longer applies.
 */
export function applyCandidate(session, meter, candidate) {
  const nodes = session.surface.nodes;
  if (candidate.type === 'result') {
    if (!nodes.includes(candidate.seq)) return 0;
    const event = session.eventAt(candidate.seq);
    if (event?.type !== 'tool/result') return 0;
    const original = session.deriveEventMessage(event);
    const message = deepFreeze(structuredClone({ ...original, content: candidate.content }));
    const before = meter.estimateMessage(original);
    const after = meter.estimateMessage(message);
    if (after >= before) return 0;
    session.append('compaction/prune', {
      shadowedRange: { start: candidate.seq, end: candidate.seq },
      shadowedSeqs: [candidate.seq],
      shadowedTokenCount: before,
    });
    session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq },
      sourceEventSeqs: [candidate.seq],
    });
    return before - after;
  }
  if (candidate.type === 'fold') {
    const start = nodes.indexOf(candidate.startSeq);
    const end = nodes.indexOf(candidate.endSeq);
    if (start < 0 || end < start) return 0;
    const seqs = nodes.slice(start, end + 1);
    let before = 0;
    for (const seq of seqs) {
      const message = session.deriveEventMessage(session.eventAt(seq));
      if (message !== null) before += meter.estimateMessage(message);
    }
    const message = deepFreeze({
      role: 'user',
      content: structuredClone(candidate.content),
      source: { kind: 'compaction-manager', foldOf: candidate.startSeq },
      id: randomUUID(),
    });
    const after = meter.estimateMessage(message);
    if (after >= before) return 0;
    session.append('compaction/prune', {
      shadowedRange: { start: candidate.startSeq, end: candidate.endSeq },
      shadowedSeqs: [...seqs],
      shadowedTokenCount: before,
    });
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: candidate.startSeq, endSeq: candidate.endSeq },
      sourceEventSeqs: [...seqs],
    });
    return before - after;
  }
  return 0;
}

function blocksText(content) {
  const parts = [];
  for (const block of content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image${block.name ? ` ${block.name}` : ''}]`);
    else parts.push(`[${block.type}]`);
  }
  return parts.join('\n');
}

function findResult(access, callId, fromSeq) {
  for (let seq = fromSeq; seq < access.length; seq += 1) {
    const event = access.eventAt(seq);
    if (event?.type === 'tool/result' && event.surfaceOp === 'append' && event.data?.message?.toolCallId === callId) return event;
  }
  return undefined;
}

function findCall(access, callId, beforeSeq) {
  for (let seq = beforeSeq; seq >= 0 && seq > beforeSeq - 5000; seq -= 1) {
    const event = access.eventAt(seq);
    if (event?.type !== 'assistant/message') continue;
    const block = event.data.message.content.find(item => item.type === 'tool-call' && item.id === callId);
    if (block !== undefined) return block;
  }
  return undefined;
}

/**
 * Recover the original text for a recall id: `r<seq>` names an appended tool
 * result, `c<seq>` an assistant message whose tool calls were folded.
 */
export function recoverOriginal(access, id) {
  const match = /^([rc])(\d+)$/.exec(String(id ?? '').trim());
  if (match === null) throw new Error(`unknown id "${id}"; ids look like r123 or c123`);
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= access.length) throw new Error(`id "${id}" is outside this session`);
  const event = access.eventAt(seq);
  if (match[1] === 'r') {
    if (event?.type !== 'tool/result') throw new Error(`id "${id}" does not name a tool result`);
    const message = event.data.message;
    const call = findCall(access, message.toolCallId, seq);
    const header = call === undefined ? `tool result ${id}` : `tool result ${id} of ${call.name}(${call.arguments})`;
    return `${header}${message.isError ? ' [error]' : ''}\n\n${blocksText(message.content)}`;
  }
  if (event?.type !== 'assistant/message') throw new Error(`id "${id}" does not name a folded tool call group`);
  const parts = [];
  const text = blocksText(event.data.message.content.filter(block => block.type === 'text'));
  if (text.trim().length > 0) parts.push(`assistant: ${text}`);
  for (const block of event.data.message.content) {
    if (block.type !== 'tool-call') continue;
    parts.push(`→ call ${block.name} (id ${block.id})\narguments: ${block.arguments}`);
    const result = findResult(access, block.id, seq + 1);
    parts.push(result === undefined ? '← (no result recorded)' : `← result${result.data.message.isError ? ' [error]' : ''}:\n${blocksText(result.data.message.content)}`);
  }
  return parts.join('\n\n');
}
