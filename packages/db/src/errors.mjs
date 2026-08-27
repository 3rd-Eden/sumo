/**
 * Lock detection for the daemon spawn race. The error class itself lives in `sumo/error`.
 * @module sumo/db/errors
 */

export { SumoError } from 'sumo/error';

/**
 * Read the structural fields this module inspects from an unknown thrown value.
 *
 * @access private
 * @param {unknown} error - Error candidate to normalize.
 * @returns {{ code?: string, message?: string, cause?: { message?: string } }} Error-like record.
 */
function errorRecord(error) {
  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  const cause = record.cause && typeof record.cause === 'object'
    ? /** @type {Record<string, unknown>} */ (record.cause)
    : {};
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    cause: { message: typeof cause.message === 'string' ? cause.message : undefined }
  };
}

/**
 * Map a thrown LevelDB open error to `SUMO_DB_LOCKED` when it is a directory-lock conflict
 * (the verified single-process-open behavior that makes the daemon spawn race safe).
 *
 * @access public
 * @param {unknown} err - Error value normalized or reported by `isLockError`.
 * @returns {boolean} Whether `isLockError` matched the expected condition.
 */
export function isLockError(err) {
  const error = errorRecord(err);
  return error.code === 'LEVEL_LOCKED' ||
    error.code === 'LEVEL_DATABASE_NOT_OPEN' && /lock/i.test(error.cause?.message ?? '') ||
    /lock/i.test(error.message ?? '') ||
    /lock/i.test(error.cause?.message ?? '');
}
