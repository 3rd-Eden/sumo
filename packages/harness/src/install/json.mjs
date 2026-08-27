/**
 * Shared JSON config file I/O for harness installers.
 *
 * Installers must reconcile idempotently, preserve malformed user files, and write atomically. An
 * absent or blank file reads as `{}`, but writing `{}` back to that state is a no-op so uninstalling a
 * never-installed harness does not create an empty config file.
 *
 * @module sumo/harness/install/json
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} JsonRead
 * @property {true} ok
 * @property {unknown} value
 * @property {boolean} existed
 * @property {string} text
 */

/**
 * Read a JSON file. Absent and blank files are treated as `{}`; malformed JSON returns a Result
 * failure so installers never clobber a user file they could not parse.
 *
 * @access public
 * @param {string} file - Path read or written by `readJson`.
 * @returns {JsonRead | { ok: false, code: string, reason: string }} Structured output from `readJson`.
 */
export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, value: {}, existed: false, text: '' };
    return { ok: false, code: 'SUMO_CONFIG_READ', reason: `could not read ${file}: ${err?.message ?? err}` };
  }
  if (!text.trim()) return { ok: true, value: {}, existed: true, text };
  try {
    return { ok: true, value: JSON.parse(text), existed: true, text };
  } catch (err) {
    return { ok: false, code: 'SUMO_CONFIG_INVALID', reason: `${file} is not valid JSON (refusing to overwrite): ${err?.message ?? err}` };
  }
}

/**
 * Detect whether a parsed JSON object has no keys.
 *
 * @access private
 * @param {unknown} value - Value to resolve.
 * @returns {unknown} Return value from `isEmptyObject`.
 */
function isEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * Write `after` only when its pretty JSON representation differs from the existing text.
 *
 * @access public
 * @param {string} file - Path read or written by `writeJsonIfChanged`.
 * @param {JsonRead} before - Marker text to insert before.
 * @param {unknown} after - After supplied to `writeJsonIfChanged`.
 * @returns {boolean} Whether `writeJsonIfChanged` matched the expected condition.
 */
export function writeJsonIfChanged(file, before, after) {
  if ((!before.existed || !before.text.trim()) && isEmptyObject(after)) return false;

  const nextText = JSON.stringify(after, null, 2) + '\n';
  if (nextText === before.text) return false;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sumo-${process.pid}.tmp`;
  fs.writeFileSync(tmp, nextText);
  fs.renameSync(tmp, file);
  return true;
}
