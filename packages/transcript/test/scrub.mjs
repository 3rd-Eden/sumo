/**
 * Shape-preserving secret scrubber for captured fixtures (CONVENTIONS §3f). Capture-first means
 * fixtures are REAL payloads, so they must be scrubbed before commit — but scrubbing replaces *values*
 * and never deletes keys, so the captured *structure* the parser maps against is preserved.
 *
 * Used two ways: by the one-off capture/build step to produce committed fixtures, and by the
 * conformance suite's audit test (`findSecrets`) to assert no committed fixture leaked a secret.
 */

/** Value patterns that look like secrets/PII regardless of their key. */
const VALUE_PATTERNS = [
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]+/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g }
];

/** Object keys whose value should be redacted wholesale. */
const SECRET_KEY = /(token|secret|password|authorization|cookie|api[-_]?key|access[-_]?key|^key)$/i;

/** Home/work absolute paths → stable placeholders (so fixtures don't pin a machine or leak layout). */
function scrubPaths(s) {
  return s
    .replace(/\/Users\/[^/\s"]+/g, '$HOME')
    .replace(/\/(?:private\/)?tmp\/[A-Za-z0-9._-]*sumo[A-Za-z0-9._-]*/g, '/tmp/sumo-capture')
    .replace(/\/(?:private\/)?tmp\/[A-Za-z0-9._-]*capture[A-Za-z0-9._-]*/gi, '/tmp/example-capture')
    .replace(/\/Volumes\/[^"\s]+/g, '/Volumes/ExampleVolume/example-project');
}

/** Long opaque blobs (encrypted reasoning, giant tool outputs) → a short marker, keeping the key. */
const MAX_STRING = 600;

/**
 * @param {unknown} value
 * @returns {unknown} a deep copy with secrets/PII/paths scrubbed and over-long strings truncated.
 */
export function scrub(value) {
  if (typeof value === 'string') {
    let s = scrubPaths(value);
    for (const { re } of VALUE_PATTERNS) s = s.replace(re, '[REDACTED]');
    if (s.length > MAX_STRING) s = s.slice(0, MAX_STRING) + '…[truncated]';
    return s;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string[]} secret-looking substrings found anywhere in `value` (for the audit test).
 */
export function findSecrets(value) {
  /** @type {string[]} */
  const hits = [];
  /** Implement walk. */ function walk(v) {
    if (typeof v === 'string') {
      for (const { kind, re } of VALUE_PATTERNS) {
        if (new RegExp(re.source).test(v)) hits.push(`${kind}: ${v.slice(0, 40)}`);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        // Mirror the scrubber's key-name rule: a secret-named key with a non-empty, un-redacted
        // string value is a leak the value-regex pass would otherwise miss (e.g. opaque tokens).
        if (SECRET_KEY.test(k) && typeof child === 'string' && child !== '' && child !== '[REDACTED]') {
          hits.push(`secret-key '${k}': ${child.slice(0, 40)}`);
        }
        walk(child);
      }
    }
  }
  walk(value);
  return hits;
}
