// Logic-less templates for compaction text. No imports: the same file is
// bundled into the browser panel for live previews.
//
//   {{name}}                    insert a variable
//   {{name|clip:80|oneline}}    insert with filters
//   {{#name}}…{{/name}}         repeat for each list item, or show once when the value is set
//   {{^name}}…{{/name}}         show when the value is empty, false, 0, or an empty list
//   {{! comment }}              ignored
//
// Templates cannot run code; variables are looked up as own properties only.

export const TEMPLATE_MAX = 4000;
const OUTPUT_MAX = 200_000;
const MAX_DEPTH = 8;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class TemplateError extends Error {
  constructor(code, detail, message) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.detail = detail;
  }
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function clipPoints(text, max) {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join('')}…`;
}

const FILTERS = {
  clip: { arg: true, apply: (text, n) => clipPoints(text, n) },
  oneline: { arg: 'optional', apply: (text, n) => { const flat = text.replace(/\s+/g, ' ').trim(); return n === undefined ? flat : clipPoints(flat, n); } },
  lines: { arg: true, apply: (text, n) => { const all = text.split('\n'); return all.length <= n ? text : `${all.slice(0, n).join('\n')}\n…`; } },
  trim: { arg: false, apply: text => text.trim() },
};
export const FILTER_NAMES = Object.keys(FILTERS);

function parseFilter(raw, source, offset) {
  const [name, arg, extra] = raw.split(':').map(part => part.trim());
  const filter = Object.hasOwn(FILTERS, name) ? FILTERS[name] : undefined;
  const line = lineOf(source, offset);
  if (filter === undefined || extra !== undefined) throw new TemplateError('bad-filter', { filter: raw, line }, `unknown filter "${raw}" on line ${line}`);
  if (arg === undefined || arg === '') {
    if (filter.arg === true) throw new TemplateError('filter-arg', { filter: name, line }, `filter "${name}" needs a number, such as ${name}:80 (line ${line})`);
    return { name };
  }
  if (filter.arg === false || !/^\d{1,6}$/.test(arg)) throw new TemplateError('filter-arg', { filter: name, line }, `filter "${name}" takes a whole number (line ${line})`);
  return { name, arg: Number(arg) };
}

/** Parse a template; throws TemplateError with a code, details and line number. */
export function parseTemplate(source) {
  if (typeof source !== 'string') throw new TemplateError('not-text', {}, 'a template must be text');
  if (Array.from(source).length > TEMPLATE_MAX) throw new TemplateError('too-long', { max: TEMPLATE_MAX }, `a template may have at most ${TEMPLATE_MAX} characters`);
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open < 0) { stack[stack.length - 1].children.push({ type: 'text', text: source.slice(i) }); break; }
    if (open > i) stack[stack.length - 1].children.push({ type: 'text', text: source.slice(i, open) });
    const close = source.indexOf('}}', open + 2);
    const line = lineOf(source, open);
    if (close < 0) throw new TemplateError('unclosed-tag', { line }, `"{{" on line ${line} is not closed with "}}"`);
    const raw = source.slice(open + 2, close).trim();
    i = close + 2;
    if (raw.startsWith('!')) continue;
    const sigil = raw[0];
    if (sigil === '#' || sigil === '^' || sigil === '/') {
      const name = raw.slice(1).trim();
      if (!NAME.test(name)) throw new TemplateError('bad-name', { name, line }, `"${name}" on line ${line} is not a valid variable name`);
      if (sigil === '/') {
        const top = stack[stack.length - 1];
        if (top === root) throw new TemplateError('stray-close', { name, line }, `"{{/${name}}}" on line ${line} has no matching opening tag`);
        if (top.name !== name) throw new TemplateError('mismatch', { name, expected: top.name, line }, `"{{/${name}}}" on line ${line} should close "${top.name}"`);
        stack.pop();
        continue;
      }
      if (stack.length > MAX_DEPTH) throw new TemplateError('too-deep', { max: MAX_DEPTH, line }, `sections may nest at most ${MAX_DEPTH} levels`);
      const node = { type: sigil === '#' ? 'section' : 'inverted', name, line, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    const [name, ...filters] = raw.split('|').map(part => part.trim());
    if (!NAME.test(name ?? '')) throw new TemplateError('bad-name', { name: name ?? '', line }, `"${name ?? ''}" on line ${line} is not a valid variable name`);
    stack[stack.length - 1].children.push({ type: 'var', name, filters: filters.map(filter => parseFilter(filter, source, open)) });
  }
  if (stack.length > 1) {
    const open = stack[stack.length - 1];
    throw new TemplateError('unclosed-section', { name: open.name, line: open.line }, `"{{#${open.name}}}" on line ${open.line} is never closed`);
  }
  return root;
}

function lookup(scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (scope && typeof scope === 'object' && !Array.isArray(scope) && Object.hasOwn(scope, name)) return scope[name];
  }
  return undefined;
}

function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== '';
}

/** Render a template (text or parsed tree) with plain-data variables. */
export function renderTemplate(template, vars) {
  const tree = typeof template === 'string' ? parseTemplate(template) : template;
  let out = '';
  const emit = text => {
    out += text;
    if (out.length > OUTPUT_MAX) throw new TemplateError('output-too-long', { max: OUTPUT_MAX }, `the rendered text is longer than ${OUTPUT_MAX} characters`);
  };
  const walk = (nodes, scopes) => {
    for (const node of nodes) {
      if (node.type === 'text') emit(node.text);
      else if (node.type === 'var') {
        const value = lookup(scopes, node.name);
        if (value === undefined || value === null || typeof value === 'object') continue;
        let text = String(value);
        for (const filter of node.filters) text = FILTERS[filter.name].apply(text, filter.arg);
        emit(text);
      } else if (node.type === 'section') {
        const value = lookup(scopes, node.name);
        if (Array.isArray(value)) for (const item of value) walk(node.children, [...scopes, item]);
        else if (truthy(value)) walk(node.children, value && typeof value === 'object' ? [...scopes, value] : scopes);
      } else if (node.type === 'inverted') {
        if (!truthy(lookup(scopes, node.name))) walk(node.children, scopes);
      }
    }
  };
  walk(tree.children, [vars ?? {}]);
  return out;
}

/** Variable names a template uses, for warning about unknown ones. */
export function templateNames(template) {
  const tree = typeof template === 'string' ? parseTemplate(template) : template;
  const names = new Set();
  const walk = nodes => {
    for (const node of nodes) {
      if (node.type === 'var' || node.type === 'section' || node.type === 'inverted') names.add(node.name);
      if (node.children) walk(node.children);
    }
  };
  walk(tree.children);
  return names;
}

/** Literal text before the first tag; identifies text this template produced. */
export function staticPrefix(template) {
  if (typeof template !== 'string') return '';
  const open = template.indexOf('{{');
  return open < 0 ? template : template.slice(0, open);
}
