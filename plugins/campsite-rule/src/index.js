/**
 * Campsite-rule enforcement engine — public API.
 *
 * This is the package boundary for the campsite system.  The engine
 * detects dismissive language and verification failures, assigns stable
 * finding IDs, filters false positives from analytical discussion, and
 * evaluates stop-time gating against a persistent resolution ledger.
 *
 * Host-specific adapters (e.g. `bin/hook.js --host cursor`) translate
 * their environment's payloads into calls against this API.
 *
 * @module campsite-rule
 */
import './guard.js';

export { CampsiteEngine } from './engine.js';
export { ResolutionLedger } from './ledger.js';
export {
  defaults as configDefaults,
  load as loadConfig,
  resolve as resolveConfig
} from './config.js';
export {
  detect,
  candidates,
  fingerprint,
  verification,
  migrate,
  analytical
} from './findings.js';
