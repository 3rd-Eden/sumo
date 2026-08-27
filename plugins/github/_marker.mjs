/**
 * HTML-comment markers for GitHub claim and lifecycle content, using the `sumo` prefix.
 *
 * Marker format: `<!-- sumo:TYPE key="value" key="value" -->`. Markers are HTML comments — invisible
 * to GitHub readers but reliably parseable — so workflow-state detection (claim/release/proof-of-life)
 * is decoupled from human-visible, themeable text. Values are HTML-entity-encoded so `"`/`&`/`<`/`>`
 * cannot break the marker or prematurely close the comment.
 *
 * This is medium-specific (HTML comments are a GitHub-shaped detail), so it lives in the adapter, not
 * the `sumo/messenger` base — a Slack adapter would coordinate via reactions, not comment markers.
 *
 * @module sumo/messenger/adapters/_marker
 */

import { SumoError } from 'sumo/error';

const PREFIX = 'sumo';

/**
 * Escape marker attribute content for a GitHub HTML comment.
 *
 * @access private
 * @param {unknown} value - Marker attribute value to stringify and escape.
 * @returns {string} HTML-entity encoded marker value.
 */
function encode(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Decode marker attribute content from a GitHub HTML comment.
 *
 * @access private
 * @param {string} value - Value to resolve.
 * @returns {string} Decoded marker value.
 */
function decode(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * Build the parser for one marker type.
 *
 * @access private
 * @param {string} type - Event name or type handled by `regex`.
 * @returns {RegExp} Regular expression matching the requested marker type.
 */
function regex(type) {
  return new RegExp(`<!-- ${PREFIX}:${type}((?:\\s+\\w+="[^"]*")*) -->`);
}

/**
 * Parse marker key-value attributes.
 *
 * @access private
 * @param {string} raw - Raw attribute section captured from a marker.
 * @returns {Record<string,string>} Decoded marker attributes.
 */
function pairs(raw) {
  /** @type {Record<string,string>} */
  const data = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) data[m[1]] = decode(m[2]);
  return data;
}

/**
 * Produce a marker string. Values are HTML-entity-encoded.
 *
 * @access public
 * @param {string} type - Event name or type handled by `mark`.
 * @param {Record<string, unknown>} data - Data object to encode.
 * @returns {string} String returned by `mark`.
 */
export function mark(type, data) {
  if (!type) throw new SumoError({ name: 'github', method: 'marker', code: 'SUMO_INVALID_ARGUMENT', message: 'type is required' });
  const entries = Object.entries(data ?? {});
  const payload = entries.length ? ' ' + entries.map(([k, v]) => `${k}="${encode(v)}"`).join(' ') : '';
  return `<!-- ${PREFIX}:${type}${payload} -->`;
}

/**
 * Whether `body` contains a marker of `type`.
 *
 * @access public
 * @param {string} body - GitHub comment body.
 * @param {string} type - Event name or type handled by `has`.
 * @returns {boolean} Whether `has` matched the expected condition.
 */
export function has(body, type) {
  if (!body) return false;
  return regex(type).test(body);
}

/**
 * Extract the key-value data of the first marker of `type` in `body`, or `null`.
 *
 * @access public
 * @param {string} body - GitHub comment body.
 * @param {string} type - Event name or type handled by `parse`.
 * @returns {Record<string,string>|null} Structured output from `parse`.
 */
export function parse(body, type) {
  if (!body) return null;
  const m = body.match(regex(type));
  if (!m) return null;
  return pairs(m[1]);
}
