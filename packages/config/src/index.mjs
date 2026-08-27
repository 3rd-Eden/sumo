/**
 * `sumo/config` — the configuration resolution layer (spec 06).
 *
 * A standalone, daemon-independent pure function: `resolve({ cwd, flags, env, pluginSchemas })`
 * walks the `sumo.yml` chain (global → parents → nearest → env → flags), merges with the system's
 * replace-vs-merge discipline (plus the `use:` `~name` disable), validates core blocks against
 * `ConfigSchema` and each plugin slice against its declared schema, and returns a merged config plus a
 * collected `DiagnosticSchema[]` — never throwing on the first error.
 *
 * @module sumo/config
 */

export { resolve } from './resolve.mjs';
export { project } from './discover.mjs';
export { ConfigSchema, DiagnosticSchema, ErrorSchema } from './schema.mjs';
export { sumoHome, globalConfigPath, explicitConfigPath, applyEnv } from './env.mjs';

/** Default wait for daemon autostart to bring both sockets online. */
export const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 15_000;
