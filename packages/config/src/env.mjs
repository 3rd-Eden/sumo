/**
 * Environment + path handling for config resolution (spec 06 "Environment"). Env overrides config
 * files; flags override env. This module is the single place the three `SUMO_*` vars are read.
 *
 * @module sumo/config/env
 */

import os from 'node:os';
import path from 'node:path';

/**
 * The global Sumo home (`~/.sumo` unless `SUMO_HOME` overrides it). Kept local to `sumo/config` —
 * deliberately not imported from `sumo/db/paths` — so this package stays daemon/storage-independent
 * and reads only the filesystem it must. Both consumers read the same env var, so they agree.
 *
 * @access public
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {string} String returned by `sumoHome`.
 */
export function sumoHome(env = process.env) {
  return env.SUMO_HOME || path.join(os.homedir(), '.sumo');
}

/**
 * Absolute path of the global config file (`<home>/sumo.yml`).
 *
 * @access public
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {string} String returned by `globalConfigPath`.
 */
export function globalConfigPath(env = process.env) {
  return path.join(sumoHome(env), 'sumo.yml');
}

/**
 * The explicit "nearest" config path, if one was given. Flags win over env (`--config` beats
 * `SUMO_CONFIG`); both are the env/flag equivalent of pointing at the nearest config (spec 06).
 *
 * @access public
 * @param {{ config?: string }} flags - Flag overrides used by the operation.
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {string|undefined} String undefined returned by `explicitConfigPath`.
 */
export function explicitConfigPath(flags = {}, env = process.env) {
  return flags.config ?? env.SUMO_CONFIG ?? undefined;
}

/**
 * Overlay environment variables onto an already-merged config (spec 06): `SUMO_DB` overrides
 * `storage.path`. Returns a new object; the input is not mutated.
 *
 * @access public
 * @param {Record<string, unknown>} config - Configuration object.
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {Record<string, unknown>} Structured output from `applyEnv`.
 */
export function applyEnv(config, env = process.env) {
  if (!env.SUMO_DB) return config;
  const next = structuredClone(config);
  next.storage = { ...(next.storage ?? {}), path: env.SUMO_DB };
  return next;
}
