/**
 * `sumo/plugin` — the plugin runtime's public surface (specs 03 / 03a).
 *
 * A plugin is `function plugin(sumo, options)`, default-exported, that calls flat verbs
 * (`on`/`before`/`command`/`skill`/`run`/`store`/`install`/`use`/`destroy` + provider-side
 * `harness`/`messenger`). `plugin()` wires those verbs to `sumo/config` and `sumo/db`,
 * builds the objects handed into plugins, and runs the single-pass lifecycle.
 *
 * @module sumo/plugin
 */

/**
 * Shared operational result envelope returned by plugin-facing helpers.
 *
 * @template T
 * @typedef {import('./schema.mjs').Result<T>} Result
 */

/**
 * Plugin-scoped key-value store handle.
 *
 * @typedef {import('./schema.mjs').Store} Store
 */

export { plugin } from './runtime.mjs';
// Re-export the capability contract so plugin authors can `import { create } from 'sumo/plugin'`
// alongside the verbs they already use (the contract itself lives in the focused `sumo/capability`).
export { create, toJSON } from 'sumo/capability';
export { registry } from './engine.mjs';
export { storage } from './store.mjs';
export { toEvent, toSteer, toContext } from './received.mjs';
export { providers } from './providers.mjs';
export { registration, load, dependencies, sort } from './use.mjs';
export {
  ok, fail, isResult, CAP_UNSUPPORTED, ErrorSchema, DeclSchema, DepSchema, HandlerSchema, STEER_TIMEOUT_MS, OBSERVE_TIMEOUT_MS, RUNTIME_PLUGIN_ID
} from './schema.mjs';
