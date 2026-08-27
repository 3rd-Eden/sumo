/**
 * Subprocess failure classification for smart failover and recovery.
 *
 * Classify CLI subprocess evidence into Sumo's operational error taxonomy. The entry point accepts
 * `{ stderr, snapshot, spawnError, exitCode, signal }` instead of provider-specific exception types.
 *
 * Usage: call `classify(transport.evidence)` on any failure path (lifecycle close, open() throw) to
 * get a structured `{ code, retryable, fallback, reason }` result instead of a blanket SUMO_SPAWN_FAILED.
 *
 * @module sumo/harness/base/classify
 */

// ── Error taxonomy ──────────────────────────────────────────────────────────────────────────────────
// Maps to stable SUMO_* codes (defined in schema.mjs HarnessErrorCode).

// Patterns that indicate billing exhaustion (not transient rate limit).
// Billing and account-balance patterns.
const BILLING_PATTERNS = [
  'insufficient credits',
  'insufficient_quota',
  'insufficient balance',
  'credit balance',
  'credits exhausted',
  'credits have been exhausted',
  'no usable credits',
  'top up your credits',
  'payment required',
  'billing hard limit',
  'exceeded your current quota',
  'account is deactivated',
  'plan does not include',
  'out of funds',
  'run out of funds',
  'balance_depleted',
  'model_not_supported_on_free_tier',
  'not available on the free tier'
];

// Patterns that indicate rate limiting (transient, will resolve).
// Provider rate-limit patterns.
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'requests per minute',
  'tokens per minute',
  'requests per day',
  'try again in',
  'please retry after',
  'resource_exhausted',
  'rate increased too quickly',
  'throttlingexception',
  'too many concurrent requests',
  'servicequotaexceededexception'
];

// Usage-limit patterns that need disambiguation (could be billing OR rate_limit).
// Usage-limit patterns.
const USAGE_LIMIT_PATTERNS = [
  'usage limit',
  'quota',
  'limit exceeded',
  'key limit exceeded'
];

// Patterns confirming usage limit is transient (not billing).
// Signals that distinguish transient limits from exhausted usage.
const USAGE_LIMIT_TRANSIENT_SIGNALS = [
  'try again',
  'retry',
  'resets at',
  'reset in',
  'wait',
  'requests remaining',
  'periodic',
  'window'
];

// Model-not-found patterns.
const MODEL_NOT_FOUND_PATTERNS = [
  'is not a valid model',
  'invalid model',
  'model not found',
  'model_not_found',
  'does not exist',
  'no such model',
  'unknown model',
  'unsupported model'
];

// Authentication patterns.
const AUTH_PATTERNS = [
  'invalid api key',
  'invalid_api_key',
  'authentication',
  'unauthorized',
  'forbidden',
  'invalid token',
  'token expired',
  'token revoked',
  'access denied',
  // CLI-specific authentication phrases.
  'not logged in',
  'please log in',
  'login required',
  'sign in',
  'api key not set',
  'no api key',
  'missing api key',
  'failed to resolve external api key auth',
  'provider auth command',
  'auth provider command'
];

// Content-policy rejection patterns.
const CONTENT_POLICY_BLOCKED_PATTERNS = [
  'flagged for possible cybersecurity risk',
  'trusted access for cyber',
  'violates our usage policies',
  'violates openai\'s usage policies',
  'your request was flagged by',
  'prompt was flagged by our safety',
  'responses cannot be generated due to safety',
  'content_filter',
  'responsibleaipolicyviolation'
];

// Overloaded / server-side transient patterns.
const OVERLOADED_PATTERNS = [
  'service unavailable',
  'temporarily unavailable',
  'server overloaded',
  'server is busy',
  'capacity exceeded',
  'try again later'
];

// ── OS-level spawn error codes ─────────────────────────────────────────────────────────────────────
// ENOENT = binary not on PATH; EACCES = not executable; ENOEXEC = bad executable format.
const SPAWN_UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM']);

// ── Classification result ───────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Classification
 * @property {string} code        - a SUMO_* error code (see HarnessErrorCode in schema.mjs)
 * @property {boolean} retryable  - the caller may retry the same harness after a backoff
 * @property {boolean} fallback   - the caller should try a different harness/provider
 * @property {string} reason      - human-readable explanation
 */

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Classify subprocess failure evidence into a structured recovery recommendation.
 * Priority-ordered pipeline:
 *  1. OS-level spawn errors (ENOENT → SUMO_BACKEND_UNAVAILABLE)
 *  2. Content-policy blocks (deterministic, don't retry unchanged)
 *  3. Usage-limit disambiguation: billing vs rate_limit (the 402-transient rule)
 *  4. Billing exhaustion
 *  5. Rate limiting
 *  6. Auth required
 *  7. Model not found
 *  8. Server overloaded
 *  9. Fallback: SUMO_SPAWN_FAILED (unknown, retryable with backoff)
 *
 * @access public
 * @param {{ stderr?: string, snapshot?: string, spawnError?: Error|null, exitCode?: number|null, signal?: string|null }} evidence - Evidence text to classify.
 * @returns {Classification} Classification returned by `classify`.
 */
export function classify(evidence = {}) {
  const { stderr = '', snapshot = '', spawnError = null } = evidence;

  // ── 1. OS-level spawn error ────────────────────────────────────────────────
  if (spawnError) {
    const errorRecord = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (spawnError));
    const osCode = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
    if (osCode && SPAWN_UNAVAILABLE_CODES.has(osCode)) {
      return { code: 'SUMO_BACKEND_UNAVAILABLE', retryable: false, fallback: true, reason: `backend binary not available: ${spawnError.message}` };
    }
    // Other OS errors (e.g. EMFILE) — surface as generic spawn failure
    return { code: 'SUMO_SPAWN_FAILED', retryable: true, fallback: false, reason: spawnError.message };
  }

  // Build combined message string from all text evidence (lowercased for case-insensitive matching).
  // Combine all evidence parts and remove duplicate text.
  const parts = [];
  if (stderr) parts.push(stderr.toLowerCase());
  if (snapshot && snapshot.toLowerCase() !== stderr.toLowerCase()) parts.push(snapshot.toLowerCase());
  const msg = parts.join(' ');

  if (!msg.trim()) {
    // No evidence text at all — cannot classify further
    return { code: 'SUMO_SPAWN_FAILED', retryable: true, fallback: false, reason: 'unknown failure (no error output captured)' };
  }

  // ── 2. Content-policy block (deterministic, don't retry unchanged) ─────────
  if (CONTENT_POLICY_BLOCKED_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_SPAWN_FAILED', retryable: false, fallback: true, reason: 'request blocked by content policy' };
  }

  // ── 3. Usage-limit disambiguation: billing vs rate_limit ───────────────────
  // An HTTP 402 or usage-limit message can still describe a periodic quota:
  // "Usage limit, try again in 5 minutes" is NOT billing — it's a periodic quota that resets.
  const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => msg.includes(p));
  if (hasUsageLimit) {
    const hasTransientSignal = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => msg.includes(p));
    if (hasTransientSignal) {
      return { code: 'SUMO_RATE_LIMITED', retryable: true, fallback: true, reason: 'usage quota (transient, will reset)' };
    }
    return { code: 'SUMO_BUDGET_EXHAUSTED', retryable: false, fallback: true, reason: 'API usage limit or budget exhausted' };
  }

  // ── 4. Billing exhaustion ──────────────────────────────────────────────────
  if (BILLING_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_BUDGET_EXHAUSTED', retryable: false, fallback: true, reason: 'API budget or credits exhausted' };
  }

  // ── 5. Rate limiting ───────────────────────────────────────────────────────
  if (RATE_LIMIT_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_RATE_LIMITED', retryable: true, fallback: true, reason: 'API rate limit exceeded' };
  }

  // ── 6. Auth required ───────────────────────────────────────────────────────
  if (AUTH_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_AUTH_REQUIRED', retryable: false, fallback: true, reason: 'authentication required or credentials invalid' };
  }

  // ── 7. Model not found ─────────────────────────────────────────────────────
  if (MODEL_NOT_FOUND_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_MODEL_NOT_FOUND', retryable: false, fallback: false, reason: 'model not found or invalid model name' };
  }

  // ── 8. Server overloaded ───────────────────────────────────────────────────
  if (OVERLOADED_PATTERNS.some((p) => msg.includes(p))) {
    return { code: 'SUMO_OVERLOADED', retryable: true, fallback: true, reason: 'backend service overloaded or temporarily unavailable' };
  }

  // ── 9. Unknown — retryable with backoff ────────────────────────────────────
  return { code: 'SUMO_SPAWN_FAILED', retryable: true, fallback: false, reason: 'unclassified failure' };
}
