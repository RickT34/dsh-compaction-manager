// Integration with the official compaction packages.
//
// The Web app mounts compaction-basic and tool-result-pruner inside each agent
// preset in an isolated group, so a host-plane plugin cannot replace the
// `toolResultPruner` service there. Instead this module wraps the two official
// classes' prototype methods while the plugin is loaded:
//   • ToolResultPruner.prototype.pruneSession → runs the configured pipeline.
//     With the default pipeline it calls the original method unchanged.
//   • BasicCompactionEngine.prototype.{compactIfNeeded, compactPressure,
//     summarize, compactNow} → apply panel overrides of compaction-basic's
//     policy. With no overrides the instance config is left untouched.
// Disposing the plugin restores every original method and config.

const ORIGINALS = Symbol.for('dsh-compaction-manager.originals');
const BASIC_CONFIG = Symbol.for('dsh-compaction-manager.basic-config');
const ENGINE_ID = Symbol.for('dsh-compaction-manager.engine-id');
let nextEngineId = 1;

// Services may be reached through Cordis traceable proxies; defineProperty has
// no proxy trap, so it always lands on the real instance.
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: key === 'config' });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const BASIC_KEYS = ['thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens', 'summarizationProvider', 'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries'];

/** Validate panel overrides for compaction-basic; returns a cleaned object. */
export function cleanBasicOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const ratio = (key) => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`${key} must be a number in (0, 1]`);
    out[key] = v;
  };
  const int = (key, min) => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer ≥ ${min}`);
    out[key] = v;
  };
  ratio('thresholdRatio');
  ratio('retainRatio');
  int('headroomTokens', 0);
  int('retainTokens', 0);
  int('maxTokens', 1);
  int('compactionRetries', 0);
  int('maxOverflowRetries', 0);
  if (out.retainRatio !== undefined && out.retainTokens !== undefined) throw new Error('retainRatio and retainTokens are mutually exclusive');
  const provider = typeof raw.summarizationProvider === 'string' ? raw.summarizationProvider.trim() : '';
  const model = typeof raw.summarizationModel === 'string' ? raw.summarizationModel.trim() : '';
  if ((provider === '') !== (model === '')) throw new Error('summarizationProvider and summarizationModel must be set together');
  if (provider !== '') { out.summarizationProvider = provider; out.summarizationModel = model; }
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  return out;
}

function mergeBasic(original, overrides) {
  const merged = { ...original };
  for (const key of BASIC_KEYS) if (overrides[key] !== undefined) merged[key] = overrides[key];
  if (overrides.retainTokens !== undefined) delete merged.retainRatio;
  if (overrides.retainRatio !== undefined) delete merged.retainTokens;
  if (overrides.headroomTokens !== undefined && overrides.maxTokens === undefined && original.maxTokens === original.headroomTokens) merged.maxTokens = Math.max(1, overrides.headroomTokens);
  if (merged.retainRatio !== undefined && merged.retainRatio >= merged.thresholdRatio) throw new Error(`retainRatio (${merged.retainRatio}) must be less than thresholdRatio (${merged.thresholdRatio})`);
  return deepFreeze(merged);
}

/**
 * Install the wrappers.
 * @param modules - { pruner: ToolResultPruner class?, basic: BasicCompactionEngine class? }
 * @param hooks - { runPipeline(pruner, session, original), basicOverrides(), autoEnabled(), logger, stats }
 * @returns disposer restoring originals
 */
export function installIntegration(modules, hooks) {
  const restores = [];
  const wrap = (proto, name, make) => {
    if (typeof proto?.[name] !== 'function') return false;
    const store = proto[ORIGINALS] ?? (proto[ORIGINALS] = {});
    if (store[name] !== undefined) throw new Error(`compaction-manager: ${name} is already wrapped (another copy is loaded)`);
    const original = proto[name];
    store[name] = original;
    proto[name] = make(original);
    restores.push(() => {
      proto[name] = original;
      delete store[name];
    });
    return true;
  };

  const status = { pruner: false, basic: false };
  const prunerProto = modules.pruner?.prototype;
  status.pruner = wrap(prunerProto, 'pruneSession', original => function pruneSession(session) {
    hooks.stats.prunerCalls += 1;
    return hooks.runPipeline(this, session, original);
  });

  const basicProto = modules.basic?.prototype;
  if (basicProto !== undefined) {
    const sync = (engine) => {
      if (engine[BASIC_CONFIG] === undefined) setOwn(engine, BASIC_CONFIG, engine.config);
      const original = engine[BASIC_CONFIG];
      let overrides = {};
      try { overrides = cleanBasicOverrides(hooks.basicOverrides()); } catch (error) {
        hooks.logger.warn(`compaction-manager: ignoring invalid compaction-basic overrides: ${error.message}`);
      }
      const keys = Object.keys(overrides).filter(key => key !== 'auto');
      let next = original;
      if (keys.length > 0) {
        try { next = mergeBasic(original, overrides); } catch (error) {
          hooks.logger.warn(`compaction-manager: ignoring compaction-basic overrides: ${error.message}`);
        }
      }
      if (engine.config !== next) setOwn(engine, 'config', next);
      if (engine[ENGINE_ID] === undefined) setOwn(engine, ENGINE_ID, nextEngineId++);
      if (!hooks.stats.basicEngines.has(engine[ENGINE_ID])) hooks.stats.basicEngines.set(engine[ENGINE_ID], engine);
      return overrides.auto !== false;
    };
    const ok = [
      wrap(basicProto, 'compactIfNeeded', original => async function compactIfNeeded(agent, trigger, signal) {
        if (!sync(this)) return null;
        return original.call(this, agent, trigger, signal);
      }),
      wrap(basicProto, 'compactPressure', original => async function compactPressure(agent, header, signal, requireBelowThreshold) {
        const auto = sync(this);
        if (!auto && requireBelowThreshold === true) return null;
        return original.call(this, agent, header, signal, requireBelowThreshold);
      }),
      wrap(basicProto, 'summarize', original => async function summarize(input, agent, signal) {
        sync(this);
        return original.call(this, input, agent, signal);
      }),
      wrap(basicProto, 'compactNow', original => function compactNow(agent, signal, sourceCommandId) {
        sync(this);
        return original.call(this, agent, signal, sourceCommandId);
      }),
    ];
    status.basic = ok.every(Boolean);
    restores.push(() => {
      for (const engine of hooks.stats.basicEngines.values()) {
        const original = engine[BASIC_CONFIG];
        if (original !== undefined) setOwn(engine, 'config', original);
        setOwn(engine, BASIC_CONFIG, undefined);
      }
      hooks.stats.basicEngines.clear();
    });
  }

  return {
    status,
    dispose() {
      for (const restore of restores.reverse()) {
        try { restore(); } catch { /* best effort */ }
      }
    },
  };
}
