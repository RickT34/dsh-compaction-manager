// dsh-compaction-manager host half: unified compaction configuration, an
// extensible method registry, the restore_context tool, and preview routes.
import z from '@deepseek-ai/schemastery';
import { RECALL_TOOL, buildView } from './core.js';
import { DEFAULT_PIPELINE, MethodRegistry, normalizePipeline } from './registry.js';
import { installIntegration, cleanBasicOverrides } from './integration.js';
import { enabledSteps, estimatorOf, fallbackEstimate, isDefaultPipeline, previewSession, recallActive, runPipeline } from './pipeline.js';
import { liveAccessor, recoverOriginal, snapshotAccessor, surfaceEntries } from './session-view.js';
import { render } from './format-runtime.js';
import { cleanPreset, exportFile, mergeImported, parsePresetFile, savePreset, storedUserPresets, toStored } from './user-presets.js';

export const name = 'compaction-manager';
export const inject = ['sessions', 'tools', 'connection'];

const stepSchema = z.object({
  id: z.string(),
  method: z.string(),
  enabled: z.boolean().default(true),
  options: z.dict(z.any()).default({}),
  formats: z.dict(z.string()),
});

export const Config = z.object({
  pipeline: z.array(stepSchema).default(DEFAULT_PIPELINE).volatile()
    .description('Ordered model-free compaction steps run when compaction triggers. A method may appear several times. The default runs only the official head/tail trim.'),
  basic: z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number(),
    headroomTokens: z.number(),
    maxTokens: z.number(),
    compactionRetries: z.number(),
    maxOverflowRetries: z.number(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    auto: z.boolean(),
  }).volatile().description('Overrides of compaction-basic. Empty means the official values.'),
  recall: z.union(['auto', 'always', 'never']).default('auto').volatile()
    .description('When restore_context is offered: auto = only while an enabled step leaves recall ids.'),
  userPresets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    steps: z.array(stepSchema),
  })).default([]).volatile().description('Presets saved or imported in the panel.'),
});

const MAX_BODY = 256 * 1024;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('request too large');
  if (text.trim() === '') return {};
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadOfficial(logger = console) {
  const out = {};
  try { out.pruner = (await import('@deepseek-ai/dsh-compaction-tool-result-pruner')).ToolResultPruner; } catch (error) {
    logger.warn(`compaction-manager: tool-result-pruner unavailable: ${error.message}`);
  }
  try { out.basic = (await import('@deepseek-ai/dsh-compaction-basic')).BasicCompactionEngine; } catch (error) {
    logger.warn(`compaction-manager: compaction-basic unavailable: ${error.message}`);
  }
  try {
    const session = await import('@deepseek-ai/dsh-session');
    out.foldSurface = session.foldSurface;
    out.deriveEventMessage = session.deriveEventMessage;
  } catch (error) {
    logger.warn(`compaction-manager: dsh-session helpers unavailable: ${error.message}`);
  }
  return out;
}

// Resolve the official classes once, at module load. The profile runtime maps
// these peers to the installation's own copies, so the prototypes patched here
// are the ones every agent preset instantiates.
const official = await loadOfficial();

export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const registry = new MethodRegistry();
  const read = (key, fallback) => {
    const ref = config?.[key];
    const value = ref && typeof ref.get === 'function' ? ref.get() : ref;
    return value ?? fallback;
  };
  const stats = { prunerCalls: 0, runs: [], basicEngines: new Map(), prunerConfigs: new Map() };
  const currentPrunerConfig = () => stats.prunerConfigs.values().next().value ?? { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

  // Extension point for other plugins: ctx.compactionMethods.register(method).
  ctx.provide('compactionMethods', {
    // Callers own the returned disposers: ctx.effect(() => ctx.compactionMethods.register(method)).
    register: method => registry.register(method),
    registerPreset: preset => registry.registerPreset(preset),
    // Render a format template: ctx.compactionMethods.render(options.formats.notice, vars).
    render: (template, vars) => render(template, vars),
    list: () => registry.describe(),
    presets: () => allPresets(),
  });

  const userPresets = () => storedUserPresets(read('userPresets', []), registry);
  function allPresets() {
    const user = userPresets().map(preset => ({
      id: preset.id,
      user: true,
      name: { zh: preset.name, en: preset.name },
      summary: { zh: preset.summary, en: preset.summary },
      steps: preset.steps,
      warnings: preset.warnings,
    }));
    return [...registry.describePresets(), ...user];
  }

  const integration = installIntegration(official, {
    logger,
    stats,
    basicOverrides: () => read('basic', {}),
    runPipeline(pruner, session, original) {
      const pipeline = read('pipeline', DEFAULT_PIPELINE);
      const steps = enabledSteps(pipeline, registry);
      const runOfficial = target => original.call(pruner, target);
      const meter = pruner.ctx?.tokenMeter ?? ctx.get('tokenMeter');
      const prunerConfig = pruner.config;
      if (prunerConfig) stats.prunerConfigs.set(`${prunerConfig.thresholdChars}/${prunerConfig.headChars}/${prunerConfig.tailChars}`, prunerConfig);
      // Exactly the default pipeline: behave as if this plugin were absent.
      if (isDefaultPipeline(pipeline)) {
        return runOfficial(session);
      }
      if (steps.length === 0) return { pruned: [], charsRemoved: 0 };
      const report = runPipeline({ session, meter, registry, pipeline, prunerConfig, runOfficial, logger });
      stats.runs.unshift({ at: Date.now(), sessionId: session.id, steps: report.steps, tokensSaved: report.tokensSaved });
      stats.runs.length = Math.min(stats.runs.length, 20);
      logger.info?.(`compaction-manager: pipeline on ${session.id}: ${report.steps.map(step => `${step.id}=${step.applied}`).join(', ')}, ~${report.tokensSaved} tokens`);
      return { pruned: report.pruned, charsRemoved: report.charsRemoved };
    },
  });
  ctx.effect(() => () => integration.dispose(), 'compaction-manager: official integration');

  // Model-facing retrieval; offered only while recall ids can exist.
  ctx.tools.register({
    name: RECALL_TOOL,
    description: 'Show the original content that context compaction replaced with a notice. Pass the id from a "[compacted … id=…]" notice (r123 for one tool result, c123 for a folded tool call group). Read-only; use it only when the hidden detail is needed and cannot simply be re-fetched.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recall id from a compaction notice, such as r123 or c123.' },
        offset: { type: 'integer', description: 'Character offset to start from; default 0.' },
        max_chars: { type: 'integer', description: 'Maximum characters to return, 1–60000; default 20000.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? `${value.text}${value.truncated ? `\n\n[… ${value.remaining} more characters; call again with offset=${value.nextOffset}]` : ''}` : JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object') throw new Error('arguments must be an object');
      const session = exec.agent?.session;
      if (session === undefined) throw new Error(`${RECALL_TOOL} requires an agent session`);
      const offset = args.offset === undefined ? 0 : args.offset;
      const max = args.max_chars === undefined ? 20000 : args.max_chars;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
      if (!Number.isSafeInteger(max) || max < 1 || max > 60000) throw new Error('max_chars must be an integer from 1 to 60000');
      const full = recoverOriginal(liveAccessor(session), args.id);
      const text = full.slice(offset, offset + max);
      const end = offset + text.length;
      return { id: String(args.id), text, truncated: end < full.length, remaining: Math.max(0, full.length - end), nextOffset: end };
    },
  }, {
    when: () => recallActive(read('pipeline', DEFAULT_PIPELINE), registry, read('recall', 'auto')),
  });

  const route = (path, handler) => ctx.connection.fetch.register({
    path: `/api/compaction-manager/${path}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return json({ ok: true, value: await handler(await body(request), request.signal) });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 400);
      }
    },
  });

  route('state', async () => ({
    methods: registry.describe(),
    pipeline: normalizePipeline(read('pipeline', DEFAULT_PIPELINE)),
    defaultPipeline: normalizePipeline(DEFAULT_PIPELINE),
    presets: allPresets(),
    basic: read('basic', {}),
    recall: read('recall', 'auto'),
    recallActive: recallActive(read('pipeline', DEFAULT_PIPELINE), registry, read('recall', 'auto')),
    integration: integration.status,
    prunerConfigs: [...stats.prunerConfigs.values()],
    basicConfigs: [...stats.basicEngines.values()].map(engine => {
      const { modelPolicies, ...rest } = engine.config ?? {};
      return { ...rest, modelPolicies: modelPolicies?.length ?? 0 };
    }),
    stats: { prunerCalls: stats.prunerCalls, runs: stats.runs },
  }));

  route('validate', async input => {
    cleanBasicOverrides(input.basic ?? {});
    return true;
  });

  // Preset routes validate and merge; the panel writes the returned list
  // through its settings form, so saving follows the normal settings path.
  route('presets/save', async input => {
    const preset = cleanPreset({ name: input.name, summary: input.summary, steps: input.steps }, registry);
    const result = savePreset(userPresets(), preset);
    return { userPresets: toStored(result.userPresets), id: result.preset.id, replaced: result.replaced, warnings: preset.warnings };
  });

  route('presets/import', async input => {
    if (typeof input.text !== 'string') throw new Error('text is required');
    let data;
    try { data = JSON.parse(input.text); } catch (error) { throw new Error(`the file is not valid JSON: ${error.message}`); }
    const { presets, errors } = parsePresetFile(data, registry);
    const merged = mergeImported(userPresets(), presets);
    return {
      userPresets: toStored(merged.userPresets),
      added: merged.added.map(preset => ({ id: preset.id, name: preset.name, warnings: preset.warnings })),
      errors,
    };
  });

  route('presets/export', async input => {
    const ids = Array.isArray(input.ids) ? new Set(input.ids.map(String)) : undefined;
    const selected = userPresets().filter(preset => ids === undefined || ids.has(preset.id));
    if (selected.length === 0) throw new Error('no preset to export');
    return exportFile(selected);
  });

  route('sessions', async (_input, signal) => {
    const out = new Map();
    for (const session of ctx.sessions.list()) {
      out.set(session.id, { id: session.id, live: true, createdAt: session.header?.createdAt ?? 0, cwd: session.header?.cwd, events: session.seq });
    }
    const query = ctx.get('sessionQuery');
    if (query !== undefined) {
      try {
        for (const record of await query.listSessions(signal)) {
          const header = record.header;
          if (header?.id === undefined || out.has(header.id) || header.parentSession !== undefined) continue;
          out.set(header.id, { id: header.id, live: record.live, createdAt: header.createdAt ?? 0, cwd: header.cwd });
        }
      } catch (error) {
        logger.warn(`compaction-manager: listSessions failed: ${error.message}`);
      }
    }
    const list = [...out.values()].filter(item => !String(item.id).startsWith('mnemon-run')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
    if (query?.readTitleSnapshots !== undefined) {
      try {
        const titles = await query.readTitleSnapshots(list.map(item => item.id), signal);
        for (const [index, result] of titles.entries()) {
          if (result.status === 'fulfilled' && result.value.title?.title) list[index].title = result.value.title.title;
        }
      } catch { /* titles are optional */ }
    }
    return list;
  });

  route('preview', async (input, signal) => {
    const sessionId = String(input.sessionId ?? '');
    if (sessionId === '') throw new Error('sessionId is required');
    const pipeline = Array.isArray(input.pipeline) ? input.pipeline : read('pipeline', DEFAULT_PIPELINE);
    let entries;
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined) entries = surfaceEntries(liveAccessor(live));
    else {
      const query = ctx.get('sessionQuery');
      if (query === undefined || official.foldSurface === undefined) throw new Error('session is not live and no session query is available');
      const snapshot = await query.readSession(sessionId);
      signal?.throwIfAborted?.();
      const fold = official.foldSurface(snapshot.events, ctx.sessions.messageProjections ?? []);
      entries = surfaceEntries(snapshotAccessor(snapshot.events, fold, official.deriveEventMessage));
    }
    const prunerConfig = currentPrunerConfig();
    const estimate = estimatorOf(ctx.get('tokenMeter'));
    const result = previewSession(entries, pipeline, registry, estimate, prunerConfig);
    const view = buildView(entries);
    const limitText = value => (value.length > 4000 ? `${value.slice(0, 4000)}\n… (${value.length - 4000} more characters)` : value);
    return {
      sessionId,
      nodes: view.nodes.length,
      toolResults: view.nodes.filter(node => node.type === 'tool').length,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      steps: result.steps.map(step => ({
        ...step,
        items: step.items.slice(0, 200).map(item => ({ ...item, before: limitText(item.before), after: limitText(item.after) })),
        more: Math.max(0, step.items.length - 200),
      })),
      manual: manualStatus(sessionId),
    };
  });

  // "Compact now": DSH accepts tool-result replacements only inside an open
  // turn (a replacement appended while idle makes the session log fail
  // validation on reload), so a request is queued and applied at the start of
  // the session's next model step, before compaction-basic's own check.
  const queued = new Map();
  const lastManual = new Map();
  function manualStatus(sessionId) {
    const agent = ctx.get('agents')?.get?.(sessionId);
    return {
      queuedAt: queued.get(sessionId)?.at ?? null,
      last: lastManual.get(sessionId) ?? null,
      agentStatus: agent?.status ?? 'none',
    };
  }
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload?.agent?.session;
    const request = session === undefined ? undefined : queued.get(session.id);
    if (request !== undefined && payload.signal?.aborted !== true) {
      queued.delete(session.id);
      try {
        const report = runPipeline({ session, meter: ctx.get('tokenMeter') ?? { estimateMessage: fallbackEstimate }, registry, pipeline: read('pipeline', DEFAULT_PIPELINE), prunerConfig: currentPrunerConfig(), logger });
        const applied = report.steps.reduce((sum, step) => sum + step.applied, 0);
        lastManual.set(session.id, { at: Date.now(), requestedAt: request.at, applied, tokensSaved: report.tokensSaved, steps: report.steps });
        stats.runs.unshift({ at: Date.now(), sessionId: session.id, steps: report.steps, tokensSaved: report.tokensSaved, manual: true });
        stats.runs.length = Math.min(stats.runs.length, 20);
        logger.info?.(`compaction-manager: manual compaction on ${session.id}: ${applied} change(s), ~${report.tokensSaved} tokens`);
      } catch (error) {
        lastManual.set(session.id, { at: Date.now(), requestedAt: request.at, error: String(error?.message ?? error) });
      }
    }
    return next();
  });
  ctx.effect(() => () => queued.clear(), 'compaction-manager: manual queue');

  route('compact-now', async input => {
    const sessionId = String(input.sessionId ?? '');
    if (sessionId === '') throw new Error('sessionId is required');
    if (input.cancel === true) {
      queued.delete(sessionId);
      return manualStatus(sessionId);
    }
    if (enabledSteps(read('pipeline', DEFAULT_PIPELINE), registry).length === 0) throw new Error('no compaction step is enabled');
    queued.set(sessionId, { at: Date.now() });
    return manualStatus(sessionId);
  });

  route('session-status', async input => manualStatus(String(input.sessionId ?? '')));

  logger.info?.(`compaction-manager: loaded (pruner hook ${integration.status.pruner ? 'on' : 'off'}, compaction-basic hook ${integration.status.basic ? 'on' : 'off'})`);
}
