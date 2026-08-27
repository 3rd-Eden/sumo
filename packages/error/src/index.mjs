/**
 * `sumo/error` — one self-documenting, self-serializing error class for the whole system.
 *
 * Every `SumoError` renders a documentation link in its `.message`, carries a stable `code` plus the
 * throw site (`package`/`method`), and serializes itself completely via `toJSON()` (custom fields and
 * the full `cause` chain included) so the same rich object survives the daemon wire and feeds
 * diagnostics. The doc link keys on the `SUMO_*` code so it survives renames (CONVENTIONS §7).
 *
 * Named placeholder substitution is delegated to `sumo/util` so prompt and error templating share
 * one implementation while preserving SumoError's legacy `{name}` formatting semantics.
 *
 * @module sumo/error
 */

import { z } from 'zod';
import { logError } from 'sumo/log';
import { renderTemplate } from 'sumo/util';

/** Central documentation file errors link into. Matches the `3rd-Eden/sumo` README skill-install ref. */
const DOCS = 'github.com/3rd-Eden/sumo/blob/main/docs/errors.md';
/** Default package scope — Sumo imports as `sumo/<pkg>`. */
const SCOPE = 'sumo';

/** The capability-failure code shared across every Sumo surface (CONVENTIONS §3b aligned #2). */
export const CAP_UNSUPPORTED = 'SUMO_CAP_UNSUPPORTED';

/**
 * @template [T=unknown]
 * @typedef {{ ok: true, value?: T } | { ok: false, code: string, reason: string }} Result
 */

/**
 * Build a success `Result`.
 *
 * @access public
 * @template T
 * @param {T} [value] - Optional success payload.
 * @returns {Result<T>} Shared Result returned by `ok`.
 */
export function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

/**
 * Build a failure `Result`.
 *
 * @access public
 * @param {string} code - Stable failure code.
 * @param {string} reason - Human-readable failure reason.
 * @returns {{ ok: false, code: string, reason: string }} Failed Result branch.
 */
export function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Is a value a `Result` envelope?.
 *
 * @access public
 * @param {unknown} v - Value to inspect.
 * @returns {boolean} Whether `isResult` matched the expected condition.
 */
export function isResult(v) {
  return typeof v === 'object' && v !== null && typeof (/** @type {Record<string, unknown>} */ (v).ok) === 'boolean';
}

/**
 * Unwrap the one nested Result layer produced when `runtime.invoke()` wraps a handler that returned
 * its own Result. Rendering surfaces use this; journey execution keeps its stricter unwrap.
 *
 * @access public
 * @template T
 * @param {Result<T>} result - Result value to inspect.
 * @returns {Result<T>|T} Shared Result returned by `unwrapNestedResult`.
 */
export function unwrapNestedResult(result) {
  const value = result?.ok === true ? result.value : undefined;
  return isResult(value) ? /** @type {Result<T>} */ (value) : result;
}

/**
 * Replace `%s` tokens positionally.
 *
 * @access private
 * @param {string} template - Template used in the generated output.
 * @param {Array<string | number>} args - Argument object accepted by `replacePositional`.
 * @returns {string} String returned by `replacePositional`.
 */
function replacePositional(template, args) {
  let index = 0;
  return template.replace(/%s/g, () => {
    const arg = args[index++];
    return arg !== undefined ? String(arg) : '%s';
  });
}

/**
 * Apply named then positional substitution to a message template.
 *
 * @access private
 * @param {string} template - Template used in the generated output.
 * @param {Record<string, unknown>} vars - Vars supplied to `substitute`.
 * @param {Array<string | number>} args - Argument object accepted by `substitute`.
 * @returns {string} String returned by `substitute`.
 */
function substitute(template, vars, args) {
  const named = Object.keys(vars).length > 0 ? renderTemplate(template, vars) : template;
  return args.length > 0 ? replacePositional(named, args) : named;
}

/**
 * The documentation anchor slug for a `SUMO_*` code, e.g. `SUMO_NO_DAEMON` → `sumo-no-daemon`.
 *
 * @access private
 * @param {string} code - Code used in the generated output.
 * @returns {string} String returned by `anchor`.
 */
function anchor(code) {
  return code.toLowerCase().replace(/_/g, '-');
}

/**
 * Resolve the documentation URL for an error code: `<docs>#error-<code>`.
 *
 * @access public
 * @param {{ code: string, docs?: string }} input - Validated input for the operation.
 * @returns {string} String returned by `docs`.
 */
export function docs({ code, docs = DOCS }) {
  const base = /^https?:\/\//.test(docs) ? docs : `https://${docs}`;
  return `${base}#error-${anchor(code)}`;
}

/**
 * @typedef {object} SumoErrorArgs
 * @property {string} name                 - originating package (e.g. `db`, or a full `@scope/x`)
 * @property {string} method               - throw site within the package (function / area)
 * @property {string} message              - human message; supports `{named}` and `%s` substitution
 * @property {string} code                 - stable `SUMO_*` category code (required; keys the doc link)
 * @property {'error'|'warning'} [severity]
 * @property {Record<string, unknown>} [vars] - named placeholder values
 * @property {Array<string|number>} [args]    - positional `%s` values
 * @property {string} [docs]               - override the docs base URL
 * @property {string} [scope]              - override the package scope
 * @property {unknown} [cause]             - the wrapped error (preserved + serialized)
 */

/**
 * The one error class. See module docs.
 *
 * @access public
 * @class
 */
export class SumoError extends Error {
  /**
   * Create an instance.
   *
   * @access public
   * @param {SumoErrorArgs & Record<string, unknown>} args - Argument object accepted by `constructor`.
   */
  constructor({ name, method, message, code, severity = 'error', vars = {}, args = [], docs: docsBase = DOCS, scope = SCOPE, cause, ...data }) {
    const reason = substitute(message, vars, args);
    const pkg = name.startsWith('@') ? name : `${scope}/${name}`;
    const url = docs({ code, docs: docsBase });
    super([`${pkg}(${method}): ${reason}`, '', `For more information visit: ${url}`].join('\n'), { cause });

    Object.assign(this, data); // intentional custom-field passthrough for extensible error metadata
    this.name = 'SumoError';
    this.package = pkg;
    this.method = method;
    this.reason = reason;
    this.code = code;
    this.severity = severity;
    this.docs = url;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, SumoError);
    logError(this, { source: 'sumo/error' });
  }

  /**
   * Auto-invoked by `JSON.stringify`. Lossless: every field, custom data, the `stack`, and the
   * recursively-serialized `cause` chain. `code` falls back to the site `id` (never a hash — the
   * hash lives only in `reference` / the doc link), so the serialized form is a superset of the
   * unified diagnostic shape.
   *
   * @access public
   * @returns {Record<string, unknown>} Structured output from `toJSON`.
  */
  toJSON() {
    const {
      name,
      package: pkg,
      method,
      code,
      reason,
      message,
      severity,
      docs: docUrl,
      stack,
      cause,
      ...data
    } = this;

    return {
      name,
      package: pkg,
      method,
      code,
      reason,
      message,
      severity,
      docs: docUrl,
      stack,
      ...data,
      cause: serializeCause(cause)
    };
  }

  /**
   * Rebuild a `SumoError` from its serialized (wire/JSON) form **without** re-running message
   * formatting — the decorated `.message` is copied verbatim so the doc link is never doubled. The
   * daemon-side throw `stack` is restored (a fresh local capture is used only when absent), and the
   * `cause` chain is reconstructed recursively.
   *
   * @access public
   * @param {Record<string, unknown>} json - Json supplied to `from`.
   * @returns {SumoError} Sumo error returned by `from`.
   */
  static from(json) {
    const err = Object.create(SumoError.prototype);
    const { cause, stack, message, ...rest } = json;
    Object.assign(err, rest);
    Object.defineProperty(err, 'message', { value: message ?? '', writable: true, configurable: true, enumerable: false });
    err.name = 'SumoError';
    err.cause = reviveCause(cause);
    if (stack) err.stack = stack;
    else Error.captureStackTrace?.(err, SumoError);
    return err;
  }

  /**
   * Wrap any thrown value as a `SumoError` at a boundary, preserving the original as `cause` so the
   * documented breadcrumb trail survives. Defaults the message to the cause's own message.
   *
   * @access public
   * @param {unknown} err - Error value normalized or reported by `wrap`.
   * @param {SumoErrorArgs & Record<string, unknown>} ctx - Execution context for the operation.
   * @returns {SumoError} Sumo error returned by `wrap`.
   */
  static wrap(err, ctx) {
    if (err instanceof SumoError && ctx.name === err.package.replace(/^.*\//, '') && ctx.method === err.method) {
      return err; // already wrapped at this exact boundary — don't double-wrap
    }
    const message = ctx.message ?? (err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err));
    return new SumoError({ ...ctx, message, cause: err });
  }
}

/**
 * Serialize a `cause` value: recurse `SumoError`s via `toJSON`, capture plain `Error`s structurally,
 * pass anything else through.
 *
 * @access private
 * @param {unknown} cause - Error value normalized or reported by `serializeCause`.
 * @returns {unknown} Return value from `serializeCause`.
 */
function serializeCause(cause) {
  if (cause instanceof SumoError) return cause.toJSON();
  if (cause instanceof Error) {
    const causeRecord = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (cause));
    return {
      name: cause.name,
      message: cause.message,
      code: causeRecord.code,
      stack: cause.stack
    };
  }
  return cause;
}

/**
 * Revive a serialized `cause`: a serialized `SumoError` (has `package`) round-trips through `from`;
 * a plain serialized `Error` becomes a real `Error`; anything else passes through.
 *
 * @access private
 * @param {unknown} cause - Error value normalized or reported by `reviveCause`.
 * @returns {unknown} Return value from `reviveCause`.
 */
function reviveCause(cause) {
  if (!cause || typeof cause !== 'object') return cause;
  if ('package' in cause) return SumoError.from(cause);
  if ('message' in cause && 'name' in cause) {
    const causeRecord = /** @type {Record<string, unknown>} */ (cause);
    const message = typeof causeRecord.message === 'string' ? causeRecord.message : String(causeRecord.message ?? '');
    const e = new Error(message);
    Object.assign(e, cause);
    if (typeof causeRecord.stack === 'string') e.stack = causeRecord.stack;
    return e;
  }
  return cause;
}

/**
 * Canonical zod contract for a serialized `SumoError` (the shape `toJSON` produces). This is the
 * error contract `sumo/db`'s control channel validates and the diagnostic surfaces consume; it is a
 * superset of `sumo/config`'s `DiagnosticSchema`. Custom fields pass through; `cause` is opaque.
 */
export const ErrorSchema = z.object({
  name: z.string(),
  package: z.string(),
  method: z.string(),
  code: z.string(),
  reason: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']).default('error'),
  docs: z.string(),
  stack: z.string().optional(),
  cause: z.unknown().optional()
}).passthrough();
