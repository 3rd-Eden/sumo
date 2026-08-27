/**
 * Config file discovery + loading (spec 06 "Resolution chain" / pseudocode). Walks up from cwd (or
 * an explicit `--config`/`SUMO_CONFIG` path) collecting `sumo.yml` files, honoring the stop rule, and
 * parses each. The global `<home>/sumo.yml` is always the first layer (it is never subject to the
 * stop rule). Parse failures become diagnostics and the file is skipped — never thrown (spec 06).
 *
 * @module sumo/config/discover
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { globalConfigPath, explicitConfigPath } from './env.mjs';

/**
 * @typedef {{ file: string, data: Record<string, unknown> }} ConfigLayer
 * @typedef {{ layers: ConfigLayer[], diagnostics: import('./schema.mjs').DiagnosticSchema[] }} ChainResult
 * @typedef {{ data?: Record<string, unknown>, diagnostic?: import('./schema.mjs').DiagnosticSchema }} ReadConfigResult
 * @typedef {{ cwd: string, flags?: { config?: string }, env?: NodeJS.ProcessEnv, home?: string }} ChainOptions
 * @typedef {ChainOptions} ProjectOptions
 */

/**
 * True for a plain object (a YAML mapping), not an array, not a scalar.
 *
 * @access private
 * @param {unknown} v - V inspected by `isMapping`.
 * @returns {v is Record<string, unknown>} True when YAML produced a mapping object.
 */
function isMapping(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read + parse one config file. A genuinely absent file (`ENOENT`) returns `{}` (the caller decides
 * whether absence is an error). Any other read failure (`EACCES`/`EISDIR`/…), a YAML parse error, or
 * a document whose root is not a mapping returns a `diagnostic` — none of these are silently dropped.
 *
 * @access public
 * @param {string} file - Path read or written by `readConfigFile`.
 * @returns {ReadConfigResult} Parsed mapping, absence marker, or diagnostic for unreadable/invalid config.
 */
export function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {}; // genuinely absent
    return {
      diagnostic: {
        code: 'SUMO_CONFIG_READ', message: `could not read config file: ${err?.message ?? err}`, severity: 'error', source: { file }
      }
    };
  }
  let data;
  try {
    data = parseYaml(text);
  } catch (err) {
    return {
      diagnostic: {
        code: 'SUMO_CONFIG_PARSE', message: `failed to parse YAML: ${err?.message ?? err}`, severity: 'error', source: { file }
      }
    };
  }
  if (data == null) return { data: {} }; // empty document → empty layer
  if (!isMapping(data)) {
    return {
      diagnostic: {
        code: 'SUMO_CONFIG_INVALID', message: `config root must be a mapping, got ${Array.isArray(data) ? 'array' : typeof data}`, severity: 'error', source: { file }
      }
    };
  }
  return { data };
}

/**
 * True when `dir` is a git repository root (a `.git` dir or worktree `.git` file lives there).
 *
 * @access private
 * @param {string} dir - Filesystem location used by `isGitRoot`.
 * @returns {boolean} True when the directory is a git root or linked worktree root.
 */
function isGitRoot(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Discover + load the ordered config layers for a cwd (spec 06). Layers are returned earliest-first:
 * the global config, then parent project configs (top-most first), then the nearest config last.
 *
 * @access public
 * @param {ChainOptions} opts - Starting directory, optional config flag, environment, and home directory.
 * @returns {ChainResult} Ordered config layers and diagnostics collected while reading them.
 */
export function loadChain({ cwd, flags = {}, env = process.env, home = os.homedir() }) {
  /** @type {import('./schema.mjs').DiagnosticSchema[]} */
  const diagnostics = [];
  /** @type {ConfigLayer[]} */
  const projectLayers = []; // nearest-first while collecting; reversed to top-most-first at the end

  const explicit = explicitConfigPath(flags, env);
  let startDir;

  if (explicit) {
    // Resolve a relative --config / SUMO_CONFIG against the request cwd, not process.cwd() — the
    // daemon resolves config per-request-cwd (spec 06), so process.cwd() would be wrong there.
    const abs = path.resolve(cwd, explicit);
    const r = readConfigFile(abs);
    if (r.diagnostic) diagnostics.push(r.diagnostic);
    else if (r.data === undefined) {
      diagnostics.push({
        code: 'SUMO_CONFIG_NOT_FOUND', message: `config file not found: ${abs}`, severity: 'error', source: { file: abs }
      });
    } else {
        projectLayers.push({ file: abs, data: r.data });
      // `root: true` in the explicit config isolates it from the parent chain (global still layers).
      if (r.data.root === true) {
        return finish(env, projectLayers, diagnostics);
      }
    }
    startDir = path.dirname(abs); // continue the upward walk from the explicit file's directory's parent
    startDir = path.dirname(startDir);
  } else {
    startDir = path.resolve(cwd);
  }

  let dir = startDir;
  // Walk up collecting sumo.yml at each directory until the stop rule fires.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, 'sumo.yml');
      const alreadyHave = projectLayers.some((l) => l.file === candidate);
    if (!alreadyHave) {
      const r = readConfigFile(candidate);
      if (r.diagnostic) diagnostics.push(r.diagnostic);
      else if (r.data !== undefined) {
        projectLayers.push({ file: candidate, data: r.data });
        if (r.data.root === true) break; // (a) root:true halts the upward walk
      }
    }
    if (isGitRoot(dir) || dir === home) break; // (b) git root / (c) $HOME
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return finish(env, projectLayers, diagnostics);
}

/**
 * Resolve a stable PROJECT KEY for a working directory — the identity under which the daemon hosts one
 * shared plugin runtime (spec 12). Two cwds that resolve to the SAME effective project config share a
 * runtime; cwds in different projects get different keys (so plugins/policy never bleed across them).
 * The key is the directory of the nearest project `sumo.yml` (the config that defines the project);
 * absent any project config, it is the nearest git root, else the resolved cwd. The global config is
 * never the key (it is shared by every project, not project-identifying).
 *
 * @access public
 * @param {ProjectOptions} opts - Working directory and config inputs used to derive project identity.
 * @returns {string} Directory key for the project-scoped daemon runtime.
 */
export function project({ cwd, flags = {}, env = process.env, home = os.homedir() }) {
  const { layers } = loadChain({ cwd, flags, env, home });
  const globalFile = globalConfigPath(env);
  const projectLayers = layers.filter((l) => l.file !== globalFile);
  if (projectLayers.length) return path.dirname(projectLayers[projectLayers.length - 1].file); // nearest project config dir
  // No project config: group by the nearest git root, else fall back to the resolved cwd.
  let dir = path.resolve(cwd);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isGitRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

/**
 * Prepend the global layer (if present) and order project layers top-most-first.
 *
 * @access private
 * @param {NodeJS.ProcessEnv} env - Environment used to locate the global config file.
 * @param {ConfigLayer[]} projectLayers - Project config layers collected nearest-first.
 * @param {import('./schema.mjs').DiagnosticSchema[]} diagnostics - Diagnostics accumulated while walking project configs.
 * @returns {ChainResult} Global layer plus project layers in merge order.
 */
function finish(env, projectLayers, diagnostics) {
  /** @type {ConfigLayer[]} */
  const layers = [];
  const globalFile = globalConfigPath(env);
  const g = readConfigFile(globalFile);
  if (g.diagnostic) diagnostics.push(g.diagnostic);
  else if (g.data !== undefined) layers.push({ file: globalFile, data: g.data });

  layers.push(...projectLayers.reverse()); // top-most parent first, nearest last
  return { layers, diagnostics };
}
