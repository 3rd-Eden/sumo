/**
 * Minimal raw-payload redaction at the storage boundary.
 *
 * The dedicated security/privacy spec is still unwritten, so this module intentionally stays small:
 * it prevents common secret shapes from being persisted in `raw:` records without trying to become a
 * full policy engine.
 *
 * @module sumo/db/redaction
 */

const REDACTED_SECRET = '[REDACTED:secret]';
const REDACTED_TOKEN = '[REDACTED:token]';
const SECRET_KEY_RE = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential)/i;
const BEARER_RE = /\bBearer\s+[-._~+/=A-Za-z0-9]+/g;
const COMMON_TOKEN_RE = /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g;
const ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*)=([^\s"'`]+)/g;

/**
 * Redact raw transcript payload values before storage.
 *
 * @access public
 * @param {unknown} value - Value to resolve.
 * @param {string} key - Key used by `redactRawValue`.
 * @returns {unknown} Return value from `redactRawValue`.
 */
export function redactRawValue(value, key = '') {
  if (SECRET_KEY_RE.test(key)) return redactByKey(value);
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactRawValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactRawValue(entryValue, entryKey)]));
  }
  return value;
}

/**
 * Redact a value according to its storage key.
 *
 * @access private
 * @param {unknown} value - Value to resolve.
 * @returns {unknown} Return value from `redactByKey`.
 */
function redactByKey(value) {
  if (value == null) return value;
  if (typeof value === 'object') return redactRawValue(value);
  return REDACTED_SECRET;
}

/**
 * Redact secret-like substrings from a string value.
 *
 * @access private
 * @param {string} value - Value to resolve.
 * @returns {unknown} Return value from `redactString`.
 */
function redactString(value) {
  return value
    .replace(BEARER_RE, `Bearer ${REDACTED_TOKEN}`)
    .replace(COMMON_TOKEN_RE, REDACTED_TOKEN)
    .replace(ASSIGNMENT_RE, `$1=${REDACTED_SECRET}`);
}
