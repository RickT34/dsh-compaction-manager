// Custom LLM summary prompt for compaction-basic.
//
// compaction-basic sends its summarization directive as the final user message
// of a `purpose: 'compaction'` request and keeps the text in a private
// constant. A preset (or the global settings) may carry `summaryPrompt`; the
// summarize() wrapper in integration.js marks the call with the prompt that
// applies to the session, and the `llm/stream` listener below swaps that final
// message. Everything else in the official request stays as it is: target
// model, token cap, the replayed prefix (so the prompt cache still hits) and
// error handling. An absent prompt means the official text, untouched.
import { AsyncLocalStorage } from 'node:async_hooks';

export const SUMMARY_PROMPT_MAX = 20000;
export const SUMMARY_TAG = '<compacted-summary>';

/** Copy of compaction-basic's COMPACTION_INSTRUCTION (dsh 0.2.2); test/summary-prompt.test.mjs checks it against the installed package. */
export const OFFICIAL_SUMMARY_PROMPT = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');

/**
 * Validate a prompt from untrusted input.
 * @returns the custom text, or undefined for the official prompt (absent, blank, or equal to it).
 */
export function cleanSummaryPrompt(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('summaryPrompt must be text');
  const text = raw.replace(/\r\n?/g, '\n');
  if (text.trim() === '' || text.trim() === OFFICIAL_SUMMARY_PROMPT) return undefined;
  if (Array.from(text).length > SUMMARY_PROMPT_MAX) throw new Error(`summaryPrompt is longer than ${SUMMARY_PROMPT_MAX} characters`);
  return text;
}

/** Like cleanSummaryPrompt, but stored data never throws: invalid means official. */
export function storedSummaryPrompt(raw) {
  try { return cleanSummaryPrompt(raw); } catch { return undefined; }
}

/** Set by the summarize() wrapper while compaction-basic builds its request. */
export const summaryPromptScope = new AsyncLocalStorage();

/**
 * Replace the final instruction of a compaction request made inside a marked
 * summarize() call. Mutates `options`, because a Cordis waterfall `next()`
 * continues with the original arguments.
 * @returns true when the prompt was replaced.
 */
export function rewriteSummaryRequest(options, logger) {
  const scope = summaryPromptScope.getStore();
  if (scope === undefined || scope.used || options?.purpose !== 'compaction') return false;
  const messages = options.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  const block = last?.role === 'user' && Array.isArray(last.content) && last.content.length === 1 ? last.content[0] : undefined;
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    logger?.warn?.('compaction-manager: compaction request has an unexpected shape; using the official summary prompt');
    return false;
  }
  const replacement = { ...last, content: [{ type: 'text', text: scope.prompt }] };
  const next = [...messages.slice(0, -1), replacement];
  if (!Object.isFrozen(options)) options.messages = next;
  else if (!Object.isFrozen(messages)) messages.splice(messages.length - 1, 1, replacement);
  else {
    logger?.warn?.('compaction-manager: compaction request is frozen; using the official summary prompt');
    return false;
  }
  scope.used = true;
  return true;
}
