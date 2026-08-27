/**
 * @module sumo/cli/render
 *
 * The CLI's shared rendering layer. Every command renders through these three functions so output
 * is consistent across the surface: a `Result` renderer, a `DiagnosticSchema[]` renderer, and a
 * table/`--json` helper (CONVENTIONS §3b — render the shared contracts, don't reinvent them).
 *
 * Output is written through an injected `out(line)` writer (default: stdout) so handlers and tests
 * share one rendering path. Color is applied via `node:util.styleText` and is suppressed under
 * `--json`, when stdout is not a TTY, or when `NO_COLOR` is set.
 */

import { styleText } from 'node:util';
import { unwrapNestedResult } from 'sumo/error';

/**
 * @typedef {Parameters<typeof styleText>[0]} TextFormat
 */

/**
 * Default line writer: one line to stdout.
 *
 * @access private
 * @param {string} line - Line supplied to `stdoutLine`.
 * @returns {boolean} Whether `stdoutLine` matched the expected condition.
 */
function stdoutLine(line) {
  return process.stdout.write(`${line}\n`);
}

/**
 * Whether ANSI color should be emitted for a given render call.
 *
 * @access private
 * @param {boolean} json - Json supplied to `colorOn`.
 * @returns {boolean} Whether colored output should be emitted.
 */
function colorOn(json) {
  return !json && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/**
 * Style `text` with one or more `node:util` formats, but only when `on`.
 *
 * @access private
 * @param {string} text - Text used in the generated output.
 * @param {TextFormat} format - `node:util` text format to apply.
 * @param {boolean} on - Whether color output is enabled for this render call.
 * @returns {string} Styled text when colors are enabled, otherwise the original text.
 */
function style(text, format, on) {
  return on ? styleText(format, text) : text;
}

/**
 * Render a scalar/object command value for human output.
 *
 * @access private
 * @param {unknown} value - Value to resolve.
 * @returns {string} String returned by `formatValue`.
 */
function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * Format a diagnostic `source` into a `plugin`/`file:line` locator, or '' when empty.
 *
 * @access private
 * @param {{ plugin?: string, file?: string, line?: number }} source - Source value to render.
 * @returns {string} Human-readable diagnostic source locator, or an empty string.
 */
function formatSource(source = {}) {
  if (source.plugin) return source.plugin;
  if (source.file) return source.line != null ? `${source.file}:${source.line}` : source.file;
  return '';
}

/**
 * Render a `Result`. Unwraps ONE level so a command that returns its own `Result` reads correctly:
 * `runtime.invoke()` wraps every handler return in `ok(...)`, producing `{ ok:true, value:<Result> }`.
 *
 * @access public
 * @param {import('sumo/error').Result} result - Result value to inspect.
 * @param {{ json?: boolean, out?: (line: string) => void }} opts - Options read by this operation.
 * @returns {boolean} Whether `renderResult` matched the expected condition.
 */
export function renderResult(result, { json = false, out = stdoutLine } = {}) {
  const r = /** @type {import('sumo/error').Result<unknown>} */ (unwrapNestedResult(result));

  if (json) {
    out(JSON.stringify(r));
    return r.ok === true;
  }

  const on = colorOn(json);
  if (r.ok === true) {
    if (r.value !== undefined) out(formatValue(r.value));
    else out(style('✓ ok', /** @type {TextFormat} */ ('green'), on));
    return true;
  }
  out(`${style(`✗ ${r.code}`, /** @type {TextFormat} */ ('red'), on)}  ${r.reason}`);
  return false;
}

/**
 * Render a list of diagnostics (`DiagnosticSchema[]` from config, or the plugin runtime's `Diagnostic[]`
 * — same shape). Severity-colored one-per-line; `--json` emits the raw array.
 *
 * @access public
 * @param {Array<{ code: string, message: string, severity?: 'error'|'warning', source?: object }>} diags - Diags supplied to `renderDiagnostics`.
 * @param {{ json?: boolean, out?: (line: string) => void }} opts - Options read by this operation.
 * @returns {void} Completes without producing a value.
 */
export function renderDiagnostics(diags, { json = false, out = stdoutLine } = {}) {
  if (json) {
    out(JSON.stringify(diags));
    return;
  }
  const on = colorOn(json);
  if (!diags.length) {
    out(style('no diagnostics', /** @type {TextFormat} */ ('green'), on));
    return;
  }
  for (const d of diags) {
    const sev = d.severity ?? 'error';
    const loc = formatSource(d.source);
    out(
      `${style(sev, /** @type {TextFormat} */ (sev === 'error' ? 'red' : 'yellow'), on)}  ${style(d.code, /** @type {TextFormat} */ ('bold'), on)}  ${d.message}${loc ? `  (${loc})` : ''}`
    );
  }
}

/**
 * Render rows as a column-aligned table; `--json` emits the raw rows array.
 *
 * @access public
 * @param {Array<Record<string, unknown>>} rows - Rows to render.
 * @param {Array<{ key: string, header?: string }>} columns - Columns supplied to `renderTable`.
 * @param {{ json?: boolean, out?: (line: string) => void }} opts - Options read by this operation.
 * @returns {void} Completes without producing a value.
 */
export function renderTable(rows, columns, { json = false, out = stdoutLine } = {}) {
  if (json) {
    out(JSON.stringify(rows));
    return;
  }
  const on = colorOn(json);

  /**
   * Normalize table cells before width measurement and rendering.
   *
   * @access public
   * @param {unknown} v - V inspected by `cell`.
   * @returns {string} String returned by `cell`.
   */
  function cell(v) {
    return v == null ? '' : String(v);
  }

  const headers = columns.map((c) => c.header ?? c.key);
  const widths = columns.map((c, i) => Math.max(headers[i].length, ...rows.map((row) => cell(row[c.key]).length), 0));
  /**
   * Render one padded table row using the measured column widths.
   *
   * @access public
   * @param {string[]} cells - Cells supplied to `line`.
   * @returns {string} String returned by `line`.
   */
  function line(cells) {
    return cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  }

  out(style(line(headers), /** @type {TextFormat} */ ('bold'), on));
  for (const row of rows) out(line(columns.map((c) => cell(row[c.key]))));
}
