// Format resolution shared by core and formats: overrides, parsing, caching.
// Imports only the template engine, so core.js can depend on it without a cycle.
import { parseTemplate, renderTemplate, TemplateError } from './template.js';

const FORMAT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const treeCache = new Map();

function treeOf(source) {
  let tree = treeCache.get(source);
  if (tree === undefined) {
    tree = parseTemplate(source);
    if (treeCache.size > 200) treeCache.clear();
    treeCache.set(source, tree);
  }
  return tree;
}

/** Render one template with plain-data variables; parsed trees are cached. */
export function render(source, vars) {
  return renderTemplate(treeOf(source), vars);
}

/** Clean stored format overrides: non-empty strings under valid keys. */
export function cleanFormats(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== '' && FORMAT_KEY.test(key)) out[key] = value;
  }
  return out;
}

/** Overrides that differ from the method's defaults, for storage and comparison. */
export function formatOverrides(method, raw) {
  const clean = cleanFormats(raw);
  const out = {};
  for (const format of method?.formats ?? []) {
    if (clean[format.key] !== undefined && clean[format.key] !== format.default) out[format.key] = clean[format.key];
  }
  // Keep overrides for formats this method does not (or no longer) declare only when the method is unknown.
  if (method === undefined) return clean;
  return out;
}

/**
 * Templates for every format a method declares: the override when set, else
 * the default. Throws when an override does not parse.
 */
export function resolveFormats(method, overrides) {
  const out = {};
  const clean = cleanFormats(overrides);
  for (const format of method.formats ?? []) {
    const source = clean[format.key] ?? format.default;
    try { treeOf(source); } catch (error) {
      if (error instanceof TemplateError) throw new Error(`format "${format.key}": ${error.message}`);
      throw error;
    }
    out[format.key] = source;
  }
  return out;
}
