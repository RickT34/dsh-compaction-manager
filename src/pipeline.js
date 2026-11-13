// Pipeline execution against live sessions, shared by the pruner hook, the
// optional early trigger, and previews.
import { DEFAULT_PIPELINE, buildView, normalizeCandidates, resolveOptions, previewPipeline } from './core.js';
import { applyCandidate, liveAccessor, surfaceEntries } from './session-view.js';
import { normalizePipeline } from './registry.js';

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

/** Whether resolved official-pruner options behave exactly like the preset's own pruner. */
export function isPlainOfficial(options, prunerConfig) {
  if (prunerConfig === undefined || options.recallHint === true) return false;
  return options.thresholdChars === prunerConfig.thresholdChars
    && options.headChars === prunerConfig.headChars
    && options.tailChars === prunerConfig.tailChars;
}

/** Pipeline steps that will actually run, in order. */
export function enabledSteps(rawPipeline, registry) {
  return normalizePipeline(rawPipeline, registry, DEFAULT_PIPELINE).filter(step => step.enabled && registry.get(step.method) !== undefined);
}

/** Whether any enabled step produces recall ids. */
export function recallActive(rawPipeline, registry, mode) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  for (const step of enabledSteps(rawPipeline, registry)) {
    const method = registry.get(step.method);
    try {
      const options = resolveOptions(method, step.options);
      if (typeof method.recall === 'function' && method.recall(options)) return true;
    } catch { /* invalid steps are skipped at run time too */ }
  }
  return false;
}

function stepOptions(step, method, prunerConfig) {
  if (method.id === 'official-pruner' && prunerConfig !== undefined) {
    return resolveOptions(method, { ...prunerConfig, ...step.options });
  }
  return resolveOptions(method, step.options);
}

/**
 * Run the pipeline on a live session.
 * @param context - { session, meter, registry, pipeline, prunerConfig?, runOfficial?(session), logger }
 * @returns { pruned: [], charsRemoved, tokensSaved, steps: [{ method, applied, tokensSaved, error? }] }
 */
export function runPipeline(context) {
  const { session, meter, registry, logger } = context;
  const steps = enabledSteps(context.pipeline, registry);
  const report = { pruned: [], charsRemoved: 0, tokensSaved: 0, steps: [] };
  for (const step of steps) {
    const method = registry.get(step.method);
    let options;
    try { options = stepOptions(step, method, context.prunerConfig); } catch (error) {
      logger?.warn?.(`compaction-manager: skipping ${method.id}: ${error.message}`);
      report.steps.push({ method: method.id, applied: 0, tokensSaved: 0, error: error.message });
      continue;
    }
    if (method.id === 'official-pruner' && typeof context.runOfficial === 'function' && isPlainOfficial(options, context.prunerConfig)) {
      // Untouched official settings: delegate to the original implementation.
      const result = context.runOfficial(session);
      report.pruned.push(...(result?.pruned ?? []));
      report.charsRemoved += result?.charsRemoved ?? 0;
      report.steps.push({ method: method.id, applied: result?.pruned?.length ?? 0, tokensSaved: 0, official: true });
      continue;
    }
    let applied = 0;
    let saved = 0;
    try {
      const view = buildView(surfaceEntries(liveAccessor(session)));
      const candidates = normalizeCandidates(view, method.plan(view, options) ?? []);
      for (const candidate of candidates) {
        const delta = applyCandidate(session, meter, candidate);
        if (delta > 0) { applied += 1; saved += delta; }
      }
    } catch (error) {
      // A rejected append fails the remainder of this step; earlier replacements stay durable.
      logger?.warn?.(`compaction-manager: ${method.id} stopped: ${error.message}`);
      report.steps.push({ method: method.id, applied, tokensSaved: saved, error: error.message });
      report.tokensSaved += saved;
      continue;
    }
    report.steps.push({ method: method.id, applied, tokensSaved: saved });
    report.tokensSaved += saved;
  }
  return report;
}

/** Preview the pipeline over detached entries; nothing is written. */
export function previewSession(entries, rawPipeline, registry, estimate, prunerConfig) {
  const steps = normalizePipeline(rawPipeline, registry, DEFAULT_PIPELINE).map(step => {
    const method = registry.get(step.method);
    if (method?.id === 'official-pruner' && prunerConfig !== undefined) return { ...step, options: { ...prunerConfig, ...step.options } };
    return step;
  });
  return previewPipeline(entries, steps, registry.methods, estimate);
}
