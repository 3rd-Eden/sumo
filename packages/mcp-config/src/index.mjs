/**
 * Safe inspection and reconciliation of JSON and TOML MCP configuration files.
 *
 * @module sumo/mcp-config
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import TOML from '@iarna/toml';

/**
 * @typedef {{ name: string, entry: Record<string, unknown>, matches: (entry: unknown, name: string) => boolean }} Server
 * @typedef {{ path: string, root: string, server: Server }} Options
 * @typedef {{ ok: true, exists: boolean, value: Record<string, unknown>, format: 'json'|'toml', mode: number } | { ok: false, code: string, reason: string }} ReadResult
 * @typedef {{ ok: true, value: Record<string, unknown> } | { ok: false, code: string, reason: string }} RootResult
 */

/**
 * Inspect one MCP config without changing it.
 *
 * @access public
 * @param {Options} options - Config location, server collection root, and canonical server.
 * @returns {Record<string, unknown>} Structured, write-safe inspection result.
 */
export function inspect(options) {
  const loaded = read(options.path);
  if (!loaded.ok) return loaded;

  const collection = getRoot(loaded.value, options.root);
  if (!collection.ok) return { ...collection, path: options.path };

  const matches = Object.entries(collection.value)
    .filter(([name, entry]) => options.server.matches(entry, name))
    .map(([name, entry]) => ({ name, entry }));
  const named = collection.value[options.server.name];
  const collision = named !== undefined && !options.server.matches(named, options.server.name);
  const current = matches.length === 1 && matches[0].name === options.server.name && equal(matches[0].entry, options.server.entry);

  return {
    ok: true,
    path: options.path,
    exists: loaded.exists,
    format: loaded.format,
    status: collision ? 'collision' : current ? 'healthy' : matches.length === 0 ? 'missing' : matches.length > 1 ? 'duplicate' : 'drift',
    entries: matches.map(({ name }) => name),
    aliases: matches.filter(({ name }) => name !== options.server.name).map(({ name }) => name)
  };
}

/**
 * Reconcile a recognized MCP entry while preserving foreign entries and file permissions.
 *
 * @access public
 * @param {Options & { backup?: boolean }} options - Inspection options and backup preference.
 * @returns {Record<string, unknown>} Inspection result plus mutation metadata.
 */
export function reconcile({ backup = true, ...options }) {
  const result = inspect(options);
  if (!result.ok || result.status === 'collision') return { ...result, changed: false };
  if (result.status === 'healthy') return { ...result, changed: false };

  const loaded = read(options.path);
  if (!loaded.ok) return { ...loaded, changed: false };
  const root = getRoot(loaded.value, options.root);
  if (!root.ok) return { ...root, path: options.path, changed: false };

  /** @type {Record<string, unknown>} */
  const next = structuredClone(loaded.value);
  /** @type {Record<string, unknown>} */
  const servers = record(next[options.root]) ? /** @type {Record<string, unknown>} */ (next[options.root]) : {};
  for (const [name, entry] of Object.entries(servers)) {
    if (options.server.matches(entry, name)) delete servers[name];
  }
  servers[options.server.name] = structuredClone(options.server.entry);
  next[options.root] = servers;

  const text = stringify(next, loaded.format);
  const backupPath = loaded.exists && backup ? backupFile(options.path) : undefined;
  atomicWrite(options.path, text, loaded.mode);
  return { ...inspect(options), changed: true, backup: backupPath };
}

/**
 * Read a JSON or TOML config, refusing malformed content.
 *
 * @access private
 * @param {string} path - Config path.
 * @returns {ReadResult} Parsed file result.
 */
function read(path) {
  const format = extname(path).toLowerCase() === '.toml' ? 'toml' : 'json';
  if (!existsSync(path)) return { ok: true, exists: false, value: {}, format, mode: 0o600 };
  try {
    const text = readFileSync(path, 'utf8');
    const value = text.trim() ? format === 'toml' ? TOML.parse(text) : JSON.parse(text) : {};
    if (!record(value)) return { ok: false, code: 'MCP_CONFIG_INVALID', reason: `${path} must contain an object` };
    return { ok: true, exists: true, value, format, mode: statSync(path).mode & 0o777 };
  } catch (error) {
    return { ok: false, code: 'MCP_CONFIG_INVALID', reason: `${path} is not valid ${format.toUpperCase()}: ${error.message}` };
  }
}

/**
 * Resolve the configured MCP map and reject type-confused files.
 *
 * @access private
 * @param {Record<string, unknown>} value - Parsed config object.
 * @param {string} root - MCP server map key.
 * @returns {RootResult} Config map result.
 */
function getRoot(value, root) {
  if (value[root] === undefined) return { ok: true, value: {} };
  if (!record(value[root])) return { ok: false, code: 'MCP_CONFIG_INVALID', reason: `${root} must be an object` };
  return { ok: true, value: value[root] };
}

/**
 * Serialize one complete MCP configuration.
 *
 * @access private
 * @param {Record<string, unknown>} value - Config object to write.
 * @param {'json'|'toml'} format - Target configuration format.
 * @returns {string} Serialized config.
 */
function stringify(value, format) {
  return format === 'toml' ? TOML.stringify(/** @type {Parameters<typeof TOML.stringify>[0]} */ (value)) : `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Back up one existing config alongside its source file.
 *
 * @access private
 * @param {string} path - File copied before mutation.
 * @returns {string} Backup path.
 */
function backupFile(path) {
  const backup = `${path}.bak.${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  copyFileSync(path, backup);
  return backup;
}

/**
 * Atomically replace a config, retaining restrictive source permissions when present.
 *
 * @access private
 * @param {string} path - Destination configuration path.
 * @param {string} text - Serialized configuration.
 * @param {number} mode - File permissions to preserve.
 * @returns {void} Completes after the temporary file replaces the original.
 */
function atomicWrite(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${Date.now()}.mcp-config.tmp`);
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/**
 * Determine whether a value can hold named MCP server configuration.
 *
 * @access private
 * @param {unknown} value - Value inspected at the configuration boundary.
 * @returns {value is Record<string, unknown>} Whether `value` can hold named MCP servers.
 */
function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compare structural config entries without relying on key insertion order.
 *
 * @access private
 * @param {unknown} left - First config entry.
 * @param {unknown} right - Second config entry.
 * @returns {boolean} Whether the values are structurally equal.
 */
function equal(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/**
 * Sort object keys recursively so semantically equal config entries compare equally.
 *
 * @access private
 * @param {unknown} value - Value to normalize for structural comparison.
 * @returns {unknown} Deterministically ordered representation.
 */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)]));
}
