/**
 * Plugin registration + identity + dependency ordering (spec 03 "use", , //).
 *
 * `use(arg, opts)` accepts a function, an `{ name, fn }` object, or a module specifier string. The
 * **canonical plugin id** is what keys config `plugins.<id>`, the validated `options`, the store
 * `<plugin>` segment, and derived-event dedupe — so a config block reaches the right plugin even when
 * its function name differs (): explicit `{name}` / `plugin.sumo.name` > the module-specifier
 * string (string form) > `fn.name`. Module resolution is anchored at the project cwd, not the runtime
 * source (). Declared install-dependencies (`plugin.sumo.plugins`) drive a stable topo order with
 * cycle detection (); the actual install is the installation layer's job (spec 13).
 *
 * @module sumo/plugin/use
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { SumoError } from 'sumo/error';

/**
 * @typedef {Function & { sumo?: import('./schema.mjs').PluginDeclShape }} PluginFunction
 * @typedef {{ name?: string, fn: PluginFunction }} NamedPlugin
 */

/**
 * @typedef {object} Registration
 * @property {string} id
 * @property {'fn'|'module'} kind
 * @property {PluginFunction} [fn]
 * @property {string} [moduleSpec]
 * @property {string} [moduleHref]
 * @property {unknown} [options]
 * @property {import('./schema.mjs').PluginDeclShape|undefined} [decl]
 * @property {boolean} [failed]
 * @property {boolean} [prepared]
 */

/**
 * Resolve a `use(arg, opts)` argument into a registration. Throws on a missing/anonymous id (a
 * programmer error per §3b). For a string the id IS the module specifier (matches the config key).
 *
 * @access public
 * @param {PluginFunction|NamedPlugin|string} arg - Function, named wrapper, or module specifier.
 * @param {unknown} options - Options read by this operation.
 * @returns {Registration} Registration returned by `registration`.
 */
export function registration(arg, options) {
  if (typeof arg === 'string') {
    if (!arg) throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_INVALID_PLUGIN', message: 'sumo.use(""): a non-empty module specifier is required' });
    return { id: arg, kind: 'module', moduleSpec: arg, options };
  }
  if (typeof arg === 'function') {
    const pluginFn = /** @type {PluginFunction} */ (/** @type {unknown} */ (arg));
    const decl = pluginFn.sumo;
    const id = decl?.name || arg.name;
    if (!id) throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_INVALID_PLUGIN', message: 'sumo.use(fn): the plugin function is anonymous — give it a name or use { name, fn }' });
    return { id, kind: 'fn', fn: pluginFn, options, decl };
  }
  if (arg && typeof arg === 'object' && typeof arg.fn === 'function') {
    const named = /** @type {NamedPlugin} */ (arg);
    const decl = named.fn.sumo;
    const id = named.name || decl?.name || named.fn.name;
    if (!id) throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_INVALID_PLUGIN', message: 'sumo.use({ fn }): no name given and the function is anonymous' });
    return { id, kind: 'fn', fn: named.fn, options, decl };
  }
  throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_INVALID_PLUGIN', message: 'sumo.use(arg): expected a function, a { name, fn } object, or a module specifier string' });
}

/**
 * Dynamically import a plugin module, anchored at the project cwd (). A relative/absolute
 * specifier resolves against `cwd`; a bare specifier resolves via Node package resolution from `cwd`.
 *
 * @access public
 * @param {string} spec - Object fields used to build the normalized value.
 * @param {string} cwd - Filesystem location used by `load`.
 * @returns {Promise<{ fn: Function, decl: import('./schema.mjs').PluginDeclShape|undefined, href: string }>} Promise resolving to the `load` result.
 */
export async function load(spec, cwd) {
  let href;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    href = pathToFileURL(path.resolve(cwd, spec)).href;
  } else {
    const parent = pathToFileURL(path.join(cwd, '__sumo_resolve__.js')).href;
    // Prefer the ESM resolver (honors the package's `import` exports condition), so an ESM-only
    // package resolves where CJS `require.resolve` would fail; fall back to `require.resolve`.
    try {
      href = import.meta.resolve(spec, parent);
    } catch {
      href = pathToFileURL(createRequire(parent).resolve(spec)).href;
    }
  }
  const mod = await import(href);
  const fn = /** @type {PluginFunction} */ (mod.default);
  if (typeof fn !== 'function') throw new SumoError({ name: 'plugin', method: 'load', code: 'SUMO_INVALID_PLUGIN', message: `module '${spec}' has no default-exported plugin function` });
  return { fn, decl: fn.sumo, href };
}

/**
 * The declared plugin-dependency ids of a plugin (`plugin.sumo.plugins`), normalized to id strings.
 *
 * @access public
 * @param {import('./schema.mjs').PluginDeclShape|undefined} decl - Decl supplied to `dependencies`.
 * @returns {string[]} List produced by `dependencies`.
 */
export function dependencies(decl) {
  if (!decl?.plugins) return [];
  return decl.plugins.map((d) => (typeof d === 'string' ? d : d.name));
}

/**
 * Stable topological order over plugin nodes so a declared dependency activates before its dependent.
 * Ties keep the input (user `use`) order. Dependencies not present among the nodes are left for the
 * caller to diagnose; a cycle's back-edge is recorded and broken (never throws).
 *
 * @access public
 * @param {Array<{ id: string, deps: string[] }>} nodes - Nodes supplied to `sort`.
 * @returns {{ order: string[], cycles: string[][] }} Structured output from `sort`.
 */
export function sort(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, 'visiting'|'done'>} */
  const state = new Map();
  /** @type {string[][]} */
  const cycles = [];

  /**
   * Execute `visit`.
   *
   * @access public
   * @param {string} id - Identifier used by `visit`.
   * @param {string[]} stack - Stack supplied to `visit`.
   * @returns {void} Completes without producing a value.
   */
  function visit(id, stack) {
    const node = byId.get(id);
    if (!node) return; // missing dep — caller reports it
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      cycles.push([...stack, id]);
      return; // break the back-edge
    }
    state.set(id, 'visiting');
    for (const dep of node.deps) if (byId.has(dep)) visit(dep, [...stack, id]);
    state.set(id, 'done');
    order.push(id);
  }

  for (const n of nodes) visit(n.id, []);
  return { order, cycles };
}
