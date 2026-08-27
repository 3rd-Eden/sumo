/**
 * Sumo runtime host — plugin registration, flat verbs, and workspace composition.
 * @module sumo
 */

import { plugin } from 'sumo/plugin';

export { plugin } from 'sumo/plugin';

/**
 * Host facade passed to plugin registration functions.
 * @typedef {Record<string, unknown>} SumoHost
 */

/**
 * Default root facade for programmatic plugin registration. It is backed by a real runtime; call
 * `plugin()` when lifecycle ownership or an isolated runtime is needed.
 */
export const sumo = plugin().sumo;

export default sumo;
