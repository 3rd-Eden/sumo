/**
 * `sumo/log` — shared rotating file logging for operational diagnostics.
 *
 * @module sumo/log
 */

import fs from 'node:fs';
import path from 'node:path';

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { sumoHome } from 'sumo/config';

/** @type {winston.Logger|undefined} */
let rootLogger;

/**
 * Return the shared Sumo logger instance.
 *
 * @access public
 * @returns {winston.Logger} Shared logger configured for rotating files under `~/.sumo/logs`.
 */
export function logger() {
  if (rootLogger) return rootLogger;

  const home = sumoHome();
  const dir = path.join(home, 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  rootLogger = winston.createLogger({
    level: process.env.SUMO_LOG_LEVEL || 'info',
    defaultMeta: { service: 'sumo' },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      new DailyRotateFile({
        dirname: dir,
        filename: 'sumo-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '14d'
      })
    ]
  });

  return rootLogger;
}

/**
 * Log an error-shaped value without letting logging failures affect the caller.
 *
 * @access public
 * @param {unknown} error - Error or diagnostic value to log.
 * @param {Record<string, unknown>} meta - Additional structured metadata.
 * @returns {void} Completes without producing a value.
 */
export function logError(error, meta = {}) {
  try {
    const record = toLogRecord(error);
    logger().error(record.message, { ...meta, ...record.meta });
  } catch {
    // Logging is observational only; never let it affect runtime behavior.
  }
}

/**
 * Build a structured log record for an error-like value.
 *
 * @access private
 * @param {unknown} error - Error-like value to normalize.
 * @returns {{ message: string, meta: Record<string, unknown> }} Structured log output.
 */
function toLogRecord(error) {
  if (error && typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error);
    if (typeof record.toJSON === 'function') {
      const json = /** @type {Record<string, unknown>} */ (record.toJSON());
      return {
        message: typeof json.message === 'string' ? json.message : String(json.reason ?? 'sumo error'),
        meta: json
      };
    }
    if (error instanceof Error) {
      return {
        message: error.message,
        meta: { name: error.name, stack: error.stack }
      };
    }
    if (typeof record.message === 'string') {
      return {
        message: record.message,
        meta: record
      };
    }
  }
  return { message: String(error), meta: { error } };
}
