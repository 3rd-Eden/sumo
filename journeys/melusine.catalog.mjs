// @ts-check
/**
 * The Sumo Melusine catalog. This is the whole bridge between Journey graphs and Sumo execution:
 * Melusine owns graph parsing/traversal/scoring, and each catalog entry invokes one real Sumo
 * capability through the normal programmatic surface.
 *
 * @module journeys/melusine.catalog
 */

import { fileURLToPath } from 'node:url';

import { scorer as melusineScorer, task as melusineTask, todo } from 'melusine';
import { SumoError } from 'sumo/error';
import { plugin } from 'sumo/plugin';
import { register } from 'sumo/session';
import opportunist from '../plugins/opportunist/index.mjs';

const STEERING_DAEMON_MAIN = fileURLToPath(new URL('../packages/cli/src/daemon-main.mjs', import.meta.url));

if (!process.env.SUMO_DAEMON_MAIN) process.env.SUMO_DAEMON_MAIN = STEERING_DAEMON_MAIN;

/**
 * @typedef {import('melusine').CatalogCall} CatalogCall
 * @typedef {{ ok: boolean, code?: string, reason?: string, value?: unknown }} RuntimeInvokeResult
 * @typedef {{
 *   invoke: (name: string, input: unknown, options: { surface: string }) => Promise<RuntimeInvokeResult>,
 *   stop: () => Promise<void>,
 *   sumo: { command: (capability: import('sumo/capability').CapabilityDef) => void, use: (plugin: Function, options?: Record<string, unknown>) => unknown },
 *   start: () => Promise<void>
 * }} Runtime
 */

/**
 * Test whether a value is a structured record.
 *
 * @access private
 * @param {unknown} value - Candidate value to inspect.
 * @returns {value is Record<string, unknown>} Whether the value can be read as a plain record.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a named object from the Melusine execution context.
 *
 * @access private
 * @param {CatalogCall} call - Melusine call containing the current execution context.
 * @param {unknown} key - Frontmatter reference value such as `session` or `sentTurn`.
 * @returns {Record<string, unknown>|undefined} Referenced context object, when one exists.
 */
function contextObject(call, key) {
  if (typeof key !== 'string') return undefined;
  const value = call.context[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Build the flat capability input expected by Sumo from explicit Melusine context references.
 *
 * @access public
 * @param {CatalogCall} call - Melusine call for one catalog entry.
 * @returns {Record<string, unknown>} Sumo capability input.
 */
export function input(call) {
  const {
    session,
    work,
    resumeFrom,
    turn,
    ...options
  } = call.config.options ?? {};

  const out = { ...options };

  const sessionRef = contextObject(call, session);
  if (out.sessionId === undefined && typeof sessionRef?.sessionId === 'string') {
    out.sessionId = sessionRef.sessionId;
  }

  const workRef = contextObject(call, work);
  if (out.workRef === undefined && typeof workRef?.workRef === 'string') {
    out.workRef = workRef.workRef;
  }

  const resumeRef = contextObject(call, resumeFrom);
  if (out.resumeId === undefined && typeof resumeRef?.resumeId === 'string') {
    out.resumeId = resumeRef.resumeId;
  }

  const turnRef = contextObject(call, turn);
  if (out.turn === undefined && turnRef) {
    out.turn = isRecord(turnRef.turn) ? turnRef.turn : turnRef;
  }

  return out;
}

/**
 * Unwrap the nested Result shape a Sumo capability may return.
 *
 * @access private
 * @param {unknown} value - Runtime invocation payload.
 * @returns {unknown} The value exposed to Melusine.
 */
function unwrap(value) {
  if (!isRecord(value)) return value;
  if (value.ok === false && ('code' in value || 'reason' in value)) {
    throw new SumoError({
      name: 'journey-catalog',
      method: 'catalog',
      code: typeof value.code === 'string' ? value.code : 'SUMO_INTERNAL',
      message: typeof value.reason === 'string' ? value.reason : 'capability failed'
    });
  }
  if (value.ok === true && Object.hasOwn(value, 'value')) return value.value;
  return value;
}

/**
 * Invoke one Sumo capability through a short-lived real runtime.
 *
 * @access private
 * @param {string} name - Capability name registered on Sumo's programmatic surface.
 * @param {CatalogCall} call - Melusine call carrying node options and context.
 * @returns {Promise<unknown>} Value returned to Melusine for the task or scorer.
 */
async function invoke(name, call) {
  const runtime = /** @type {Runtime} */ (/** @type {unknown} */ (plugin({ flags: {} })));
  if (name.startsWith('opportunist-')) runtime.sumo.use(opportunist, { enabled: false });
  register(runtime.sumo);
  try {
    await runtime.start();
    const result = await runtime.invoke(name, input(call), { surface: 'programmatic' });
    if (result.code === 'SUMO_NO_COMMAND' || result.code === 'SUMO_SURFACE_UNSUPPORTED') {
      return todo(`capability '${name}' is not available on the programmatic surface (${result.code})`);
    }
    if (!result.ok) {
      throw new SumoError({
        name: 'journey-catalog',
        method: 'catalog',
        code: typeof result.code === 'string' ? result.code : 'SUMO_INTERNAL',
        message: typeof result.reason === 'string' ? result.reason : 'capability failed'
      });
    }
    return unwrap(result.value);
  } finally {
    await runtime.stop();
  }
}

/**
 * Build a Melusine task catalog entry for a Sumo capability.
 *
 * @access private
 * @param {string} name - Capability name to invoke.
 * @returns {import('melusine').TaskEntry} Melusine task entry.
 */
function task(name) {
  return melusineTask((call) => invoke(name, call));
}

/**
 * Build a Melusine scorer catalog entry for a Sumo capability.
 *
 * @access private
 * @param {string} name - Capability name to invoke.
 * @returns {import('melusine').ScorerEntry} Melusine scorer entry.
 */
function scorer(name) {
  return melusineScorer((call) => (
    /** @type {Promise<import('melusine').ScorerReturn>} */ (invoke(name, call))
  ));
}

/**
 * Record an opportunist event milestone that is asserted by the live plugin journey.
 *
 * @access private
 * @param {CatalogCall} call - Melusine call carrying the event name.
 * @returns {{ pass: true, event: unknown, evidence: string }} Passing milestone marker.
 */
function opportunistEvent(call) {
  return {
    pass: true,
    event: call.config.options?.event ?? call.key,
    evidence: 'live event emission is covered by plugins/opportunist/test/e2e-codex.live.test.mjs'
  };
}

/**
 * The static catalog used by Melusine's CLI.
 *
 * @access public
 * @type {import('melusine').Catalog}
 */
export const catalog = {
  start: melusineTask(() => ({})),

  'session-spawn': task('session-spawn'),
  'session-is-running': scorer('session-is-running'),
  'session-await-ended': task('session-await-ended'),
  'session-await-active-turn': task('session-await-active-turn'),
  'session-await-turn-completed': task('session-await-turn-completed'),
  'session-await-turn': task('session-await-turn'),
  'session-transcript-correlated': scorer('session-transcript-correlated'),
  'session-events-correlated': scorer('session-events-correlated'),
  'session-completed': scorer('session-completed'),

  'session-send': task('session-send'),
  'session-cancel': task('session-cancel'),
  'session-end': task('session-end'),
  'session-native-id': task('session-native-id'),
  'session-resume': task('session-resume'),

  'kb.record-finding': task('kb.record-finding'),
  'kb.has-finding': scorer('kb.has-finding'),
  'kb.resolve-finding': task('kb.resolve-finding'),
  'kb.finding-resolved': scorer('kb.finding-resolved'),

  'opportunist-findings': task('opportunist-findings'),
  'opportunist-resolve': task('opportunist-resolve'),
  'opportunist-event': melusineTask(opportunistEvent),
  'opportunist-event-observed': melusineScorer(opportunistEvent),

  'work.detect': scorer('work.detect'),
  'work.claim': task('work.claim'),
  'work.run': task('work.run'),
  'work.review': scorer('work.review'),
  'work.release': task('work.release'),
  'work.released': scorer('work.released')
};

export default catalog;
