// Method registry: built-in methods plus methods contributed by other plugins
// through the `compactionMethods` service.
import { BUILTIN_METHODS, resolveOptions } from './core.js';

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function localized(value, fallback = '') {
  if (typeof value === 'string') return { zh: value, en: value };
  if (value && typeof value === 'object') {
    const zh = typeof value.zh === 'string' ? value.zh : (typeof value.en === 'string' ? value.en : fallback);
    const en = typeof value.en === 'string' ? value.en : zh;
    return { zh, en };
  }
  return { zh: fallback, en: fallback };
}

function validateMethod(method) {
  if (!method || typeof method !== 'object') throw new TypeError('compaction method must be an object');
  if (typeof method.id !== 'string' || !ID.test(method.id)) throw new TypeError(`compaction method id "${method?.id}" must match ${ID}`);
  if (typeof method.plan !== 'function') throw new TypeError(`compaction method "${method.id}" must define plan(view, options)`);
  if (method.options !== undefined && !Array.isArray(method.options)) throw new TypeError(`compaction method "${method.id}" options must be an array`);
  for (const option of method.options ?? []) {
    if (typeof option?.key !== 'string' || !['number', 'boolean', 'string', 'list', 'select'].includes(option.type)) {
      throw new TypeError(`compaction method "${method.id}" has an invalid option declaration`);
    }
  }
}

export class MethodRegistry {
  constructor() {
    this.methods = new Map();
    this.listeners = new Set();
    for (const method of BUILTIN_METHODS) this.methods.set(method.id, method);
  }

  /**
   * Register an extension method. The returned disposer removes it.
   * A method is `{ id, name, summary, details, options, recall(options), plan(view, options) }`;
   * `plan` returns candidates `{ type: 'result', seq, content }` or
   * `{ type: 'fold', startSeq, endSeq, content }` and must not mutate anything.
   */
  register(method) {
    validateMethod(method);
    if (this.methods.has(method.id)) throw new Error(`compaction method "${method.id}" is already registered`);
    this.methods.set(method.id, method);
    this.emit();
    return () => {
      if (this.methods.get(method.id) === method) {
        this.methods.delete(method.id);
        this.emit();
      }
    };
  }

  get(id) {
    return this.methods.get(id);
  }

  list() {
    return [...this.methods.values()];
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* listeners are best-effort */ }
    }
  }

  /** JSON-safe description for the panel. */
  describe() {
    return this.list().map(method => {
      let defaults = {};
      try { defaults = resolveOptions(method, {}); } catch { defaults = {}; }
      return {
        id: method.id,
        builtin: method.builtin === true,
        official: method.official === true,
        name: localized(method.name, method.id),
        summary: localized(method.summary),
        details: localized(method.details),
        options: (method.options ?? []).map(option => ({
          key: option.key,
          type: option.type,
          label: localized(option.label, option.key),
          hint: option.hint === undefined ? undefined : localized(option.hint),
          default: option.default,
          min: option.min,
          max: option.max,
          choices: option.choices,
        })),
        defaults,
        recall: typeof method.recall === 'function' ? Boolean(safeRecall(method, defaults)) : false,
      };
    });
  }
}

function safeRecall(method, options) {
  try { return method.recall(options); } catch { return false; }
}

/** Normalize a stored pipeline: known methods keep their order; missing built-ins are appended disabled. */
export function normalizePipeline(raw, registry, fallback) {
  const source = Array.isArray(raw) && raw.length > 0 ? raw : fallback;
  const seen = new Set();
  const out = [];
  for (const step of source) {
    if (!step || typeof step.method !== 'string' || seen.has(step.method)) continue;
    seen.add(step.method);
    out.push({
      method: step.method,
      enabled: step.enabled === true,
      options: step.options && typeof step.options === 'object' && !Array.isArray(step.options) ? { ...step.options } : {},
    });
  }
  for (const method of registry.list()) {
    if (!seen.has(method.id)) out.push({ method: method.id, enabled: false, options: {} });
  }
  return out;
}
