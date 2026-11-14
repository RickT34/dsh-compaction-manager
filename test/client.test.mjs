// Smoke test the browser bundle: load it with a fake module loader, register
// slots, and render the components with a minimal React-compatible renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// React is provided by the DSH Web app at runtime; tests use a linked copy.
const require = createRequire(import.meta.url);
let React;
try { React = require('react'); } catch { React = undefined; }

function load() {
  let factory;
  const sandbox = { window: { __ModuleLoader__: { load: def => { factory = def.factory; } } }, console, URL, document: { baseURI: 'http://x/' }, setTimeout };
  vm.runInNewContext(readFileSync, sandbox);
  return factory(name => {
    if (name === 'react') return React;
    throw new Error(`unexpected require ${name}`);
  });
}
let readFileSync;

test('client bundle registers its slots and renders', { skip: React === undefined && 'react is not linked (npm run link-dsh)' }, async () => {
  readFileSync = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  const mod = load();
  assert.equal(JSON.stringify(mod.inject), JSON.stringify(['slots', 'locale', 'configForms']));
  const registered = [];
  const effects = [];
  const ctx = {
    effect: (fn) => { effects.push(fn()); },
    locale: { register: () => () => {}, bind: () => key => key, getLocale: () => ({ active: 'zh' }), getSnapshot: () => ({ active: 'zh', revision: 1 }), subscribe: () => () => {} },
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, revision: 1 }), subscribe: () => () => {}, mutate: async () => true }) },
    slots: { inject: (_k, fn) => fn(), register: (opts, comp) => { registered.push({ opts, comp }); return () => {}; } },
    get: () => undefined,
  };
  mod.apply(ctx);
  assert.deepEqual(registered.map(r => r.opts.name).sort(), ['conversation.view', 'main', 'plugins.bundle.config', 'sidebar.panellist']);
  // Components must be callable functions returning elements.
  for (const { comp } of registered) {
    const el = comp({ view: 'summary', size: 18, sessionId: 's1' });
    assert.ok(el === null || typeof el === 'object' || typeof el === 'string');
  }
});
