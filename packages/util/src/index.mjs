import net from 'node:net';

/**
 * Small production utilities shared across Sumo packages.
 *
 * This surface is intentionally narrow: helpers belong here only when multiple packages need the same
 * semantics. Test-only process and filesystem helpers live in `sumo/util/testing`.
 *
 * @module sumo/util
 */

/**
 * Return true for objects Sumo treats as deep-mergeable records.
 *
 * @access public
 * @param {unknown} value - Value to resolve.
 * @returns {value is Record<string, unknown>} Structured output from `isPlainObject`.
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wait for a fixed number of milliseconds.
 *
 * @access public
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Promise that resolves after the delay elapses.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copy defined operational fields onto a target object.
 *
 * @access public
 * @template {Record<string, unknown>} T
 * @param {T} target - Target supplied to `withDefined`.
 * @param {Record<string, unknown>} fields - Fields supplied to `withDefined`.
 * @returns {T} T returned by `withDefined`.
 */
export function withDefined(target, fields) {
  const out = /** @type {Record<string, unknown>} */ (target);
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') out[name] = value;
  }
  return target;
}

/**
 * Return a new record containing only meaningful optional fields.
 *
 * @access public
 * @param {Record<string, unknown>} fields - Input object whose empty optional fields are omitted.
 * @returns {Record<string, unknown>} New record containing only defined fields.
 */
export function defined(fields) {
  return withDefined({}, fields);
}

/**
 * Build a stable child id for an item emitted from a parent record.
 *
 * @access public
 * @param {string | null | undefined} base - Parent id when one exists.
 * @param {number} index - Child index below the parent record.
 * @returns {string | undefined} Stable child id, or `undefined` when the parent has no id.
 */
export function idAt(base, index) {
  return base != null && base !== '' ? `${base}#${index}` : undefined;
}

/**
 * Extract concatenated text from a transcript content value.
 *
 * @access public
 * @param {unknown} content - Content value that may be a string or an array of text-like blocks.
 * @returns {string} Concatenated text content.
 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

/**
 * Render a small named-variable template.
 *
 * Variables use `{name}` or dotted paths such as `{finding.id}`. Unknown or undefined placeholders
 * are preserved so callers can detect missing data; objects and arrays render as pretty JSON.
 *
 * @access public
 * @param {string} template - Template string containing `{path}` placeholders.
 * @param {Record<string, unknown>} values - Values available to the template.
 * @returns {string} Rendered template.
 */
export function renderTemplate(template, values = {}) {
  return template.replace(/\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (match, key) => {
    const value = pathValue(values, key);
    if (value === undefined || value === null) return match;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return JSON.stringify(value, null, 2);
  });
}

/**
 * Resolve a dotted template path from a record.
 *
 * @access private
 * @param {Record<string, unknown>} values - Root values.
 * @param {string} key - Dotted key such as `sumo.cli`.
 * @returns {unknown} Resolved value.
 */
function pathValue(values, key) {
  if (Object.hasOwn(values, key)) return values[key];
  let current = /** @type {unknown} */ (values);
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = /** @type {Record<string, unknown>} */ (current)[part];
  }
  return current;
}

/**
 * Parse an ISO timestamp string to epoch milliseconds.
 *
 * @access public
 * @param {unknown} iso - Candidate ISO timestamp string.
 * @returns {number|undefined} Epoch milliseconds, or `undefined` when the input is absent or invalid.
 */
export function tsMs(iso) {
  if (typeof iso !== 'string') return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Race a promise against a timeout and always clear the timer.
 *
 * @access public
 * @template T
 * @param {Promise<T>} promise - Promise to await.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @param {string} message - Timeout message used when the timer wins.
 * @returns {Promise<T>} Promise resolving to the original value or rejecting on timeout.
 */
export function timeoutRace(promise, timeoutMs, message = 'Failed to resolve promise in a timely manner') {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}

/**
 * Deep-clone JSON-ish data, falling back to a shallow copy when structured cloning fails.
 *
 * @access public
 * @param {unknown} value - Value to clone.
 * @returns {unknown} Cloned value.
 */
export function cloneValue(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

/**
 * Resolve whether a unix socket currently accepts connections.
 *
 * @access public
 * @param {string} sockPath - Socket path to probe.
 * @returns {Promise<boolean>} True when a connection succeeds.
 */
export function canConnectSocket(sockPath) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Poll an async predicate until it returns a truthy value or the timeout elapses.
 *
 * @access public
 * @template T
 * @param {() => T | Promise<T>} predicate - Predicate retried until it returns a truthy value.
 * @param {{ timeoutMs?: number, intervalMs?: number }} options - Polling options.
 * @returns {Promise<Awaited<T>>} Truthy predicate result.
 */
export async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // Retry until timeout; callers often wait on real process or filesystem state to settle.
    }
    await sleep(intervalMs);
  }
  throw new Error('timeout waiting for condition');
}
