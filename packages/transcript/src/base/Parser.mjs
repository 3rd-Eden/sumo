/**
 * `sumo/transcript` base class (the unified adapter idiom, CONVENTIONS §3a/§4).
 *
 * A parser is an adapter: per-harness, capability-varying, keyed on the four harness ids, covered by
 * one parametrized conformance suite. The base owns the machinery — the public `stream`/`file` entry
 * points, the capability gate, and output validation — so a subclass implements only the harness
 * mapping, in the `*onStream` / `*onFile` generator hooks. It is composed by the harness adapter; there
 * is no public `sumo.transcript()` verb ().
 *
 * The parser is pure: handed one raw transcript unit, it returns normalized events. No I/O, tailing,
 * correlation, storage, redaction, or `sumo/db` imports (§3d).
 *
 * @module sumo/transcript/base
 */

import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';
import { EventSchema } from './schema.mjs';

export { ok, fail, isResult, CAP_UNSUPPORTED };

/**
 * The shared outcome envelope (CONVENTIONS §3b aligned #1). Defined locally rather than imported from
 * `sumo/plugin` to keep this pure parser free of the plugin runtime (and its db/LevelDB deps) — the
 * convention is the *shape* `{ ok:false, code, reason }`, not the import source.
 *
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

/**
 * @typedef {(input: Record<string, unknown>) => Iterable<import('./schema.mjs').NormalizedEventInput>} ParserHook
 */

/**
 * Base class for per-harness transcript adapters. Subclasses set `id`/`can`/`config` instance props and implement the `*onStream(frame)` / `*onFile(record)` mapping hooks.
 *
 * @access public
 * @class
 */
export class Parser {
  /** @type {string} the harness id (`claude-code` | `codex` | `cursor` | `opencode`). */
  id = '';

  /** @type {{ stream: boolean, file: boolean }} which entry points this parser supports. */
  can = { stream: false, file: false };

  /** @type {import('zod').ZodTypeAny} per-parser config contract (most need none). */
  config = z.object({});

  /**
   * Parse one LIVE stream frame into normalized `07` events.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `stream`.
   * @returns {Iterable<import('./schema.mjs').NormalizedEventInput> | Result} Shared Result returned by `stream`.
   */
  stream(frame) {
    return this.#entry('stream', 'onStream', frame);
  }

  /**
   * Parse one ON-DISK transcript record into normalized `07` events.
   *
   * @access public
   * @param {Record<string, unknown>} record - Record to normalize.
   * @returns {Iterable<import('./schema.mjs').NormalizedEventInput> | Result} Shared Result returned by `file`.
   */
  file(record) {
    return this.#entry('file', 'onFile', record);
  }

  /**
   * CapabilitySchema gate + validation wrapper shared by both entry points. Callers gate on `can`, so the
   * iterable path is the normal one; the `Result` is the diagnostic path for a caller that did not.
   *
   * @access public
   * @param {'stream' | 'file'} cap - Cap supplied to `entry`.
   * @param {'onStream' | 'onFile'} hook - Hook supplied to `entry`.
   * @param {Record<string, unknown>} input - Validated input for the operation.
   * @returns {Iterable<import('./schema.mjs').NormalizedEventInput> | Result} Validated events, or a capability failure result.
   */
  #entry(cap, hook, input) {
    if (!/** @type {Record<string, boolean>} */ (this.can)?.[cap]) {
      return fail(CAP_UNSUPPORTED, `${this.id || 'transcript'} has no '${cap}' entry point`);
    }
    const hooks = /** @type {Record<'onStream'|'onFile', ParserHook>} */ (/** @type {unknown} */ (this));
    return this.#validated(hooks[hook](input));
  }

  /**
   * Validate every event the subclass hook yields against the output contract. Validation at the
   * boundary (§3) — a subclass that emits an off-vocabulary type or malformed event fails loudly here.
   *
   * @access public
   * @param {Iterable<import('./schema.mjs').NormalizedEventInput>} gen - Normalized events yielded by the subclass hook.
   * @returns {Generator<import('./schema.mjs').NormalizedEventInput, void, unknown>} Validated normalized events.
   */
  *#validated(gen) {
    for (const evt of gen) {
      yield EventSchema.parse(evt);
    }
  }
}
