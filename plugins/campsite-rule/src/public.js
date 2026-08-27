/**
 * Public package entrypoint for `sumo/plugins/campsite-rule`.
 *
 * The engine's direct-file import guard remains active for internal paths while this exported wrapper
 * authorizes the package-supported import surface during module initialization.
 *
 * @module sumo/plugins/campsite-rule
 */

const publicImport = Symbol.for('sumo.campsite.public-import');
globalThis[publicImport] = true;

let campsite;
try {
  campsite = await import('./index.js');
} finally {
  delete globalThis[publicImport];
}

export const {
  CampsiteEngine,
  ResolutionLedger,
  configDefaults,
  loadConfig,
  resolveConfig,
  detect,
  candidates,
  fingerprint,
  verification,
  migrate,
  analytical
} = campsite;
