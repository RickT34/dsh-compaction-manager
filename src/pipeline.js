// Pipeline execution against live sessions, shared by the pruner hook,
// "compact now", and previews.
import { buildView, normalizeCandidates, resolveOptions, previewPipeline } from './core.js';
import { applyCandidate, liveAccessor, surfaceEntries } from './session-view.js';
import { compactedMarkers } from './formats.js';
import { cleanFormats } from './format-runtime.js';
import { normalizePipeline } from './registry.js';

const TRIM = 'trim-head-tail';
const PRUNER_KEYS = ['thresholdChars', 'headChars', 'tailChars'];

export function fallbackEstimate(message) {
  let chars = 0;
  for (const block of message?.content ?? []) {
    if (block?.type === 'text') chars += block.text.length;
    else if (block?.type === 'tool-call') chars += (block.name?.length ?? 0) + (block.arguments?.length ?? 0);
    else chars += 64;
  }
  return Math.ceil(chars / 4) + 4;
}

export function estimatorOf(meter) {
  return typeof meter?.estimateMessage === 'function' ? message => meter.estimateMessage(message) : fallbackEstimate;
}

/** Whether resolved head/tail options behave exactly like the preset's own pruner. */
export function isPlainOfficial(options, prunerConfig) {
  if (prunerConfig === undefined || options.recallHint === true) return false;
  if (options.tools?.length > 0 || options.excludeTools?.length > 0) return false;
  return PRUNER_KEYS.every(key => options[key] === prunerConfig[key]);
}

/** Whether a stored pipeline is exactly the untouched default (official trim alone). */
export function isDefaultPipeline(rawPipeline) {
  const steps = normalizePipeline(rawPipeline).filter(step => step.enabled);
  return steps.length === 1 && steps[0].method === TRIM && Object.keys(steps[0].options).length === 0
    && Object.keys(cleanFormats(steps[0].formats)).length === 0;
}

/** Head/tail options fall back to the agent preset's own pruner configuration. */
function withPrunerDefaults(step, prunerConfig) {
  if (step.method !== TRIM || prunerConfig === undefined) return step;
  const base = {};
  for (const key of PRUNER_KEYS) if (prunerConfig[key] !== undefined) base[key] = prunerConfig[key];
  return { ...step, options: { ...base, ...step.options } };
}

/** Pipeline steps that will actually run, in order. */
export function enabledSteps(rawPipeline, registry) {
  return normalizePipeline(rawPipeline).filter(step => step.enabled && registry.get(step.method) !== undefined);
}

/** Whether any enabled step produces recall ids. */
export function recallActive(rawPipeline, registry, mode) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  for (const step of enabledSteps(rawPipeline, registry)) {
    const method = registry.get(step.method);
    try {
      const options = resolveOptions(method, step.options, step.formats);
      if (typeof method.recall === 'function' && method.recall(options)) return true;
    } catch { /* invalid steps are skipped at run time too */ }
  }
  return false;
}


/**
 * Run the pipeline on a live session.
 * @param context - { session, meter, registry, pipeline, prunerConfig?, runOfficial?(session), logger }
 * @returns { pruned: [], charsRemoved, tokensSaved, steps: [{ id, method, applied, tokensSaved, error? }] }
 */
export function runPipeline(context) {
  const { session, meter, registry, logger } = context;
  const steps = enabledSteps(context.pipeline, registry);
  const markers = compactedMarkers(steps, registry);
  const report = { pruned: [], charsRemoved: 0, tokensSaved: 0, steps: [] };
  for (const step of steps) {
    const method = registry.get(step.method);
    let options;
    try { options = resolveOptions(method, withPrunerDefaults(step, context.prunerConfig).options, step.formats); } catch (error) {
      logger?.warn?.(`compaction-manager: skipping ${step.id}: ${error.message}`);
      report.steps.push({ id: step.id, method: method.id, applied: 0, tokensSaved: 0, error: error.message });
      continue;
    }
    if (method.id === TRIM && typeof context.runOfficial === 'function' && isPlainOfficial(options, context.prunerConfig)
      && Object.keys(cleanFormats(step.formats)).length === 0) {
      // Untouched official settings: delegate to the original implementation.
      const result = context.runOfficial(session);
      report.pruned.push(...(result?.pruned ?? []));
      report.charsRemoved += result?.charsRemoved ?? 0;
      report.steps.push({ id: step.id, method: method.id, applied: result?.pruned?.length ?? 0, tokensSaved: 0, official: true });
      continue;
    }
    let applied = 0;
    let saved = 0;
    try {
      const view = buildView(surfaceEntries(liveAccessor(session)), { markers });
      const candidates = normalizeCandidates(view, method.plan(view, options) ?? []);
      for (const candidate of candidates) {
        const delta = applyCandidate(session, meter, candidate);
        if (delta > 0) { applied += 1; saved += delta; }
      }
    } catch (error) {
      // A rejected append fails the remainder of this step; earlier replacements stay durable.
      logger?.warn?.(`compaction-manager: ${step.id} stopped: ${error.message}`);
      report.steps.push({ id: step.id, method: method.id, applied, tokensSaved: saved, error: error.message });
      report.tokensSaved += saved;
      continue;
    }
    report.steps.push({ id: step.id, method: method.id, applied, tokensSaved: saved });
    report.tokensSaved += saved;
  }
  return report;
}

/** Preview the pipeline over detached entries; nothing is written. */
export function previewSession(entries, rawPipeline, registry, estimate, prunerConfig) {
  const steps = normalizePipeline(rawPipeline).map(step => withPrunerDefaults(step, prunerConfig));
  const markers = compactedMarkers(steps.filter(step => step.enabled), registry);
  return previewPipeline(entries, steps, registry.methods, estimate, markers);
}
