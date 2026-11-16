// User presets: validation of untrusted preset data (panel saves and imported
// files), stable ids, and merging into the stored list.
import { resolveOptions } from './core.js';
import { ID, normalizePipeline } from './registry.js';

export const PRESET_FILE_FORMAT = 'dsh-compaction-manager.presets';
export const PRESET_FILE_VERSION = 1;
const MAX_PRESETS = 50;
const MAX_STEPS = 50;
const NAME_MAX = 60;
const SUMMARY_MAX = 400;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Copy a JSON value, rejecting non-JSON types and dropping prototype keys. */
function cleanJson(value, depth = 0) {
  if (depth > 6) throw new Error('options are nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('options contain a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error('an option list has more than 500 items');
    return value.map(item => cleanJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (!BAD_KEYS.has(key)) out[key] = cleanJson(item, depth + 1);
    return out;
  }
  throw new Error(`options contain an unsupported ${typeof value} value`);
}

function label(value, max, field) {
  let raw = value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.zh ?? raw.en;
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new Error(`${field} must be text`);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (Array.from(text).length > max) throw new Error(`${field} is longer than ${max} characters`);
  return text;
}

/**
 * Validate one preset from untrusted input.
 * @returns { name, summary, steps, warnings }
 */
export function cleanPreset(raw, registry) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a preset must be an object');
  const name = label(raw.name, NAME_MAX, 'name');
  if (name === '') throw new Error('the preset needs a name');
  const summary = label(raw.summary, SUMMARY_MAX, 'summary');
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('the preset needs at least one step');
  if (raw.steps.length > MAX_STEPS) throw new Error(`the preset has more than ${MAX_STEPS} steps`);
  const input = raw.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`step ${index + 1} must be an object`);
    if (typeof step.method !== 'string' || !ID.test(step.method)) throw new Error(`step ${index + 1} has an invalid method id`);
    const options = step.options === undefined ? {} : cleanJson(step.options);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error(`step ${index + 1} options must be an object`);
    return { id: typeof step.id === 'string' ? step.id : undefined, method: step.method, enabled: step.enabled !== false, options };
  });
  const steps = normalizePipeline(input, []);
  if (steps.length === 0) throw new Error('the preset has no usable steps');
  const warnings = [];
  for (const step of steps) {
    const method = registry.get(step.method);
    if (method === undefined) { warnings.push(`method "${step.method}" is not installed`); continue; }
    try { resolveOptions(method, step.options); } catch (error) {
      throw new Error(`step "${step.id}": ${error.message}`);
    }
  }
  return { name, summary, steps, warnings };
}

/** Accepted import shapes: a preset file, a bare preset array, or one preset. */
export function parsePresetFile(data, registry) {
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray(data.presets)) {
    if (data.format !== undefined && data.format !== PRESET_FILE_FORMAT) throw new Error('this is not a compaction preset file');
    if (typeof data.version === 'number' && data.version > PRESET_FILE_VERSION) throw new Error(`preset file version ${data.version} is newer than this plugin supports`);
    list = data.presets;
  } else if (data && typeof data === 'object' && Array.isArray(data.steps)) list = [data];
  else throw new Error('this is not a compaction preset file');
  if (list.length === 0) throw new Error('the file contains no presets');
  if (list.length > MAX_PRESETS) throw new Error(`the file contains more than ${MAX_PRESETS} presets`);
  const presets = [];
  const errors = [];
  list.forEach((raw, index) => {
    try { presets.push(cleanPreset(raw, registry)); } catch (error) {
      const name = typeof raw?.name === 'string' ? ` (${raw.name.slice(0, 40)})` : '';
      errors.push(`#${index + 1}${name}: ${error.message}`);
    }
  });
  return { presets, errors };
}

function freshId(used) {
  for (;;) {
    const id = `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!used.has(id)) { used.add(id); return id; }
  }
}

/** Stored user presets, cleaned; malformed entries are dropped, ids stay stable. */
export function storedUserPresets(raw, registry) {
  const used = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    let preset;
    try { preset = cleanPreset(item, registry); } catch { continue; }
    const id = typeof item.id === 'string' && ID.test(item.id) && !used.has(item.id) ? item.id : freshId(used);
    used.add(id);
    out.push({ id, ...preset });
  }
  return out;
}

/** Strip derived fields before writing to settings. */
export function toStored(presets) {
  return presets.map(({ id, name, summary, steps }) => ({ id, name, summary, steps }));
}

/**
 * Save one preset; a user preset with the same name is replaced in place.
 * @returns { userPresets, preset, replaced }
 */
export function savePreset(existing, preset) {
  const index = existing.findIndex(item => item.name === preset.name);
  if (index >= 0) {
    const replacedPreset = { ...preset, id: existing[index].id };
    const next = [...existing];
    next[index] = replacedPreset;
    return { userPresets: next, preset: replacedPreset, replaced: true };
  }
  const used = new Set(existing.map(item => item.id));
  const added = { ...preset, id: freshId(used) };
  return { userPresets: [...existing, added], preset: added, replaced: false };
}

/** Append imported presets; names that already exist get a numeric suffix. */
export function mergeImported(existing, imported) {
  const used = new Set(existing.map(item => item.id));
  const names = new Set(existing.map(item => item.name));
  const added = [];
  for (const preset of imported) {
    let name = preset.name;
    for (let n = 2; names.has(name); n += 1) name = `${preset.name} (${n})`;
    names.add(name);
    added.push({ ...preset, name, id: freshId(used) });
  }
  return { userPresets: [...existing, ...added], added };
}

/** File contents for exporting presets. */
export function exportFile(presets) {
  return {
    format: PRESET_FILE_FORMAT,
    version: PRESET_FILE_VERSION,
    presets: presets.map(({ name, summary, steps }) => ({ name, summary, steps })),
  };
}
