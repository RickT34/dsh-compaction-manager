// Method and preset registry: built-ins plus contributions from other plugins
// through the `compactionMethods` service.
import { resolveOptions } from './core.js';
import { cleanFormats } from './format-runtime.js';
import { describeFormats } from './formats.js';
import { parseTemplate } from './template.js';
import { cleanSummaryPrompt, storedSummaryPrompt } from './summary-prompt.js';
import { BUILTIN_METHODS } from './methods.js';
import { BUILTIN_PRESETS, DEFAULT_PIPELINE, migrateLegacyStep } from './presets.js';

export const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPTION_TYPES = ['number', 'boolean', 'string', 'list', 'select'];

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
    if (typeof option?.key !== 'string' || !OPTION_TYPES.includes(option.type)) throw new TypeError(`compaction method "${method.id}" has an invalid option declaration`);
  }
  if (method.formats !== undefined && !Array.isArray(method.formats)) throw new TypeError(`compaction method "${method.id}" formats must be an array`);
  const keys = new Set();
  for (const format of method.formats ?? []) {
    if (typeof format?.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(format.key) || keys.has(format.key)) throw new TypeError(`compaction method "${method.id}" has an invalid or repeated format key`);
    keys.add(format.key);
    if (typeof format.default !== 'string') throw new TypeError(`compaction method "${method.id}" format "${format.key}" needs a default template`);
    parseTemplate(format.default);
  }
}

function validatePreset(preset) {
  if (!preset || typeof preset !== 'object') throw new TypeError('compaction preset must be an object');
  if (typeof preset.id !== 'string' || !ID.test(preset.id)) throw new TypeError(`compaction preset id "${preset?.id}" must match ${ID}`);
  if (!Array.isArray(preset.steps) || preset.steps.length === 0) throw new TypeError(`compaction preset "${preset.id}" needs at least one step`);
  for (const item of preset.steps) {
    if (typeof item?.method !== 'string') throw new TypeError(`compaction preset "${preset.id}" has a step without a method`);
  }
  try { cleanSummaryPrompt(preset.summaryPrompt); } catch (error) {
    throw new TypeError(`compaction preset "${preset.id}": ${error.message}`);
  }
}

export class MethodRegistry {
  constructor() {
    this.methods = new Map();
    this.presets = new Map();
    this.listeners = new Set();
    for (const method of BUILTIN_METHODS) this.methods.set(method.id, method);
    for (const preset of BUILTIN_PRESETS) this.presets.set(preset.id, preset);
  }

  /**
   * Register an extension method; the returned disposer removes it.
   * A method is `{ id, name, summary, details, options, tagKeys?, recall(options), plan(view, options) }`.
   * `plan` returns candidates `{ type: 'result', seq, content }` or
   * `{ type: 'fold', startSeq, endSeq, content }` and must not mutate anything.
   */
  register(method) {
    validateMethod(method);
    if (this.methods.has(method.id)) throw new Error(`compaction method "${method.id}" is already registered`);
    this.methods.set(method.id, method);
    this.emit();
    return () => {
      if (this.methods.get(method.id) === method) { this.methods.delete(method.id); this.emit(); }
    };
  }

  /** Register a preset `{ id, name, summary, steps: [{ method, enabled?, options? }], summaryPrompt? }`; returns its disposer. */
  registerPreset(preset) {
    validatePreset(preset);
    if (this.presets.has(preset.id)) throw new Error(`compaction preset "${preset.id}" is already registered`);
    this.presets.set(preset.id, preset);
    this.emit();
    return () => {
      if (this.presets.get(preset.id) === preset) { this.presets.delete(preset.id); this.emit(); }
    };
  }

  get(id) { return this.methods.get(id); }
  list() { return [...this.methods.values()]; }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* listeners are best-effort */ }
    }
  }

  /** JSON-safe method descriptions for the panel. */
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
          choices: option.choices?.map(choice => ({ value: choice.value, label: localized(choice.label, String(choice.value)) })),
        })),
        tagKeys: Array.isArray(method.tagKeys) ? method.tagKeys.filter(key => typeof key === 'string') : [],
        formats: describeFormats(method).map(format => ({
          ...format,
          label: localized(format.label, format.key),
          vars: format.vars.map(item => ({ ...item, description: localized(item.description) })),
        })),
        defaults,
        recall: typeof method.recall === 'function' ? Boolean(safeRecall(method, defaults)) : false,
      };
    });
  }

  /** JSON-safe preset descriptions, with normalized steps; no summaryPrompt means the official one. */
  describePresets() {
    return [...this.presets.values()].map(preset => {
      const summaryPrompt = storedSummaryPrompt(preset.summaryPrompt);
      return {
        id: preset.id,
        builtin: preset.builtin === true,
        name: localized(preset.name, preset.id),
        summary: localized(preset.summary),
        steps: normalizePipeline(preset.steps),
        ...(summaryPrompt === undefined ? {} : { summaryPrompt }),
      };
    });
  }
}

function safeRecall(method, options) {
  try { return method.recall(options); } catch { return false; }
}

function plainOptions(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

/**
 * Normalize a stored pipeline: expand 0.1.x legacy methods, keep step order,
 * and give every step a unique instance id. Unknown methods are kept so a
 * temporarily missing extension does not lose its configuration.
 */
export function normalizePipeline(raw, fallback = DEFAULT_PIPELINE) {
  const source = Array.isArray(raw) ? raw : fallback;
  const steps = [];
  let legacy = false;
  for (const item of source) {
    if (!item || typeof item.method !== 'string') continue;
    const migrated = migrateLegacyStep(item);
    if (migrated !== undefined) { legacy = true; steps.push(...migrated); continue; }
    const formats = cleanFormats(item.formats);
    steps.push({ id: typeof item.id === 'string' ? item.id : undefined, method: item.method, enabled: item.enabled !== false, options: plainOptions(item.options), ...(Object.keys(formats).length > 0 ? { formats } : {}) });
  }
  // A legacy pipeline with nothing enabled was the untouched 0.1.x default.
  if (legacy && steps.length === 0) return normalizePipeline(fallback, []);
  const used = new Set();
  return steps.map(item => {
    let id = item.id && ID.test(item.id) ? item.id : item.method;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    return { ...item, id };
  });
}

export { DEFAULT_PIPELINE };
