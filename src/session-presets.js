// Per-session compaction choice: a session may name a preset; otherwise it
// inherits its parent's choice (subagents), and finally the global steps.
import { ID } from './registry.js';

const MAX_DEPTH = 8;

/** Keep only well-formed `sessionId → presetId` entries. */
export function cleanSessionPresets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sessionId, presetId] of Object.entries(raw)) {
    if (typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200 && typeof presetId === 'string' && ID.test(presetId)) out[sessionId] = presetId;
  }
  return out;
}

/**
 * Resolve the steps and summary prompt a session uses. Both come from the
 * same place: a preset carries its own prompt, the global steps the global one.
 * @param sessionId - session being compacted or previewed.
 * @param context - { choices, presets: Map(id → { name, steps, summaryPrompt? }), globalPipeline, globalSummaryPrompt?, parentOf(id) }
 * @returns { source: 'session'|'parent'|'global', from?, presetId?, presetName?, pipeline, summaryPrompt?, missing? }
 */
export function resolveSessionPipeline(sessionId, { choices, presets, globalPipeline, globalSummaryPrompt, parentOf }) {
  let id = sessionId;
  let missing;
  const seen = new Set();
  for (let depth = 0; id && depth < MAX_DEPTH && !seen.has(id); depth += 1) {
    seen.add(id);
    const presetId = choices[id];
    if (presetId !== undefined) {
      const preset = presets.get(presetId);
      if (preset !== undefined) {
        return { source: depth === 0 ? 'session' : 'parent', from: id, presetId, presetName: preset.name, pipeline: preset.steps, summaryPrompt: preset.summaryPrompt, missing };
      }
      // A deleted preset falls through to the parent, then the global steps.
      missing ??= { sessionId: id, presetId };
    }
    let parent;
    try { parent = parentOf(id); } catch { parent = undefined; }
    id = typeof parent === 'string' ? parent : undefined;
  }
  return { source: 'global', pipeline: globalPipeline, summaryPrompt: globalSummaryPrompt, missing };
}
