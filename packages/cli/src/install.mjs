/**
 * Project setup reconciliation for `sumo install` / `sumo doctor`.
 *
 * @module sumo/cli/install
 */

import fs from 'node:fs';
import path from 'node:path';

import TOML from '@iarna/toml';

import { resolve } from 'sumo/config';
import { plugin } from 'sumo/plugin';
import { claude, codex, copilot, cursor } from 'sumo/harness';

const JSON_MCP_FILES = ['.mcp.json', '.cursor/mcp.json'];
const CODEX_MCP_FILE = '.codex/config.toml';
const MCP_NAME = 'sumo';
const MCP_MARKER = 'sumo-managed:mcp';
const SKILL_DIR = '.agents/skills';
const SKILL_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * @typedef {{ ok: true, value: unknown, text: string, existed: boolean } | { ok: false, code: string, reason: string }} JsonRead
 * @typedef {{ ok: true, text: string, existed: boolean } | { ok: false, code: string, reason: string }} TextRead
 * @typedef {{ code?: string, message?: string, reason?: string, severity?: 'error'|'warning', source?: Record<string, unknown> }} InstallDiagnostic
 * @typedef {{ command?: string, args?: string[], env?: Record<string, string> }} McpServerEntry
 * @typedef {Record<string, unknown> & { mcpServers?: Record<string, McpServerEntry> }} McpJsonConfig
 * @typedef {{ ok: true, changed: boolean, path: string, warnings?: string[] } | { ok: false, code: string, reason: string }} InstallResult
 * @typedef {{ install: (opts: { projectDir: string, env?: NodeJS.ProcessEnv }) => InstallResult, path: (projectDir: string) => string, SENTINEL?: string, HOOK_SENTINEL?: string }} HookInstaller
 * @typedef {{ plugin: string, spec: { skills?: Array<{ name?: string, source?: string }> }, sourceBase?: string }} PluginInstallIntent
 * @typedef {{ plugin: string, name: string, source: string, sourceBase?: string }} SkillInstall
 * @typedef {{ diagnostics: InstallDiagnostic[], intents: PluginInstallIntent[] }} CollectedInstallIntents
 * @typedef {{ ok: true, current: boolean, exists: boolean, hasFrontmatter: boolean } | { ok: false, code: string, reason: string }} SkillInspection
 */

/** @type {Record<string, HookInstaller>} */
export const HOOK_INSTALLERS = {
  'claude-code': claude,
  codex,
  copilot,
  cursor
};

/** Sumo stdio MCP server entry installed into repo-local MCP config files. */
export const SUMO_MCP_ENTRY = Object.freeze({
  command: 'sumo',
  args: ['mcp'],
  env: {
    SUMO_MANAGED: MCP_MARKER
  }
});

/**
 * Read JSON, treating a missing/blank file as `{}`.
 *
 * @access private
 * @param {string} file - Path read or written by `readJson`.
 * @returns {JsonRead} Parsed JSON value or a diagnostic preserving the user file.
 */
function readJson(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        value: {},
        text: '',
        existed: false
      };
    }
    return {
      ok: false,
      code: 'SUMO_CONFIG_READ',
      reason: `could not read ${file}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
    };
  }
  if (!text.trim()) {
    return {
      ok: true,
      value: {},
      text,
      existed: true
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(text),
      text,
      existed: true
    };
  } catch (err) {
    return {
      ok: false,
      code: 'SUMO_CONFIG_INVALID',
      reason: `${file} is not valid JSON (refusing to overwrite): ${/** @type {Error} */ (err).message}`
    };
  }
}

/**
 * Write pretty JSON only when content changes.
 *
 * @access private
 * @param {string} file - Path read or written by `writeJson`.
 * @param {{ text: string, existed: boolean }} before - Marker text to insert before.
 * @param {unknown} value - Value to resolve.
 * @returns {boolean} Whether `writeJson` matched the expected condition.
 */
function writeJson(file, before, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (before.existed && before.text === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/**
 * Detect whether an MCP server entry is Sumo-managed.
 *
 * @access private
 * @param {unknown} entry - MCP server entry to inspect.
 * @returns {boolean} True when the entry is Sumo-owned MCP wiring.
 */
function isSumoMcp(entry) {
  const record = entry && typeof entry === 'object' ? /** @type {McpServerEntry} */ (entry) : {};
  return record.env?.SUMO_MANAGED === MCP_MARKER || (record.command === 'sumo' && Array.isArray(record.args) && record.args[0] === 'mcp');
}

/**
 * Merge the Sumo MCP server into one config file.
 *
 * @access private
 * @param {string} file - Path read or written by `installMcpFile`.
 * @returns {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} Structured output from `installMcpFile`.
 */
function installMcpFile(file) {
  const r = readJson(file);
  if (!r.ok) return r;
  const next = /** @type {McpJsonConfig} */ (structuredClone(r.value && typeof r.value === 'object' ? r.value : {}));
  const servers = next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
  next.mcpServers = servers;
  servers[MCP_NAME] = structuredClone(SUMO_MCP_ENTRY);
  return {
    ok: true,
    changed: writeJson(file, r, next),
    path: file
  };
}

/**
 * Detect whether a JSON MCP config already contains Sumo.
 *
 * @access private
 * @param {string} file - Path read or written by `hasMcp`.
 * @returns {boolean} Whether `hasMcp` matched the expected condition.
 */
function hasMcp(file) {
  const r = readJson(file);
  const value = r.ok ? /** @type {McpJsonConfig} */ (r.value && typeof r.value === 'object' ? r.value : {}) : {};
  return r.ok && Object.values(value.mcpServers ?? {}).some(isSumoMcp);
}

/**
 * Read a text file, treating a missing file as empty.
 *
 * @access private
 * @param {string} file - Path read or written by `readText`.
 * @returns {TextRead} File text or a diagnostic preserving the user file.
 */
function readText(file) {
  try {
    return {
      ok: true,
      text: fs.readFileSync(file, 'utf8'),
      existed: true
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        text: '',
        existed: false
      };
    }
    return {
      ok: false,
      code: 'SUMO_CONFIG_READ',
      reason: `could not read ${file}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
    };
  }
}

/**
 * Write text only when content changes.
 *
 * @access private
 * @param {string} file - Path read or written by `writeText`.
 * @param {{ text: string, existed: boolean }} before - Marker text to insert before.
 * @param {string} text - Text used in the generated output.
 * @returns {boolean} Whether `writeText` matched the expected condition.
 */
function writeText(file, before, text) {
  if (before.existed && before.text === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/**
 * Merge the Sumo MCP server into Codex's project-scoped `.codex/config.toml`.
 *
 * @access private
 * @param {string} file - Path read or written by `installCodexMcpFile`.
 * @returns {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} Structured output from `installCodexMcpFile`.
 */
function installCodexMcpFile(file) {
  const r = readText(file);
  if (!r.ok) return r;
  /** @type {Record<string, unknown>} */
  let parsed = {};
  if (r.text.trim()) {
    try {
      parsed = /** @type {Record<string, unknown>} */ (TOML.parse(r.text));
    } catch (err) {
      return {
        ok: false,
        code: 'SUMO_CONFIG_INVALID',
        reason: `${file} is not valid TOML (refusing to overwrite): ${/** @type {Error} */ (err).message}`
      };
    }
  }
  const next = structuredClone(parsed);
  const servers = next.mcp_servers && typeof next.mcp_servers === 'object' ? /** @type {Record<string, unknown>} */ (next.mcp_servers) : {};
  next.mcp_servers = servers;
  servers[MCP_NAME] = {
    command: 'sumo',
    args: ['mcp'],
    env: {
      SUMO_MANAGED: MCP_MARKER
    }
  };
  const text = TOML.stringify(/** @type {Parameters<typeof TOML.stringify>[0]} */ (next));
  return {
    ok: true,
    changed: writeText(file, r, text),
    path: file
  };
}

/**
 * Detect whether Codex config already contains Sumo MCP wiring.
 *
 * @access private
 * @param {string} file - Path read or written by `hasCodexMcp`.
 * @returns {boolean} Whether `hasCodexMcp` matched the expected condition.
 */
function hasCodexMcp(file) {
  const r = readText(file);
  if (!r.ok || !r.text.trim()) return false;
  try {
    const parsed = /** @type {Record<string, unknown>} */ (TOML.parse(r.text));
    const servers = parsed.mcp_servers && typeof parsed.mcp_servers === 'object' ? /** @type {Record<string, unknown>} */ (parsed.mcp_servers) : {};
    const entry = servers[MCP_NAME];
    const record = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {};
    const env = record.env && typeof record.env === 'object' ? /** @type {Record<string, unknown>} */ (record.env) : {};
    return env.SUMO_MANAGED === MCP_MARKER;
  } catch {
    return false;
  }
}

/**
 * Write install diagnostics to the selected output sink.
 *
 * @access private
 * @param {Array<{ code?: string, message?: string, reason?: string }>} diagnostics - Diagnostics supplied to `reportDiagnostics`.
 * @param {(s: string) => void} out - Output function used by `reportDiagnostics`.
 * @returns {void} Completes without producing a value.
 */
function reportDiagnostics(diagnostics, out) {
  for (const d of diagnostics) out(`${d.code ?? 'SUMO_DIAGNOSTIC'}: ${d.message ?? d.reason ?? ''}`);
}

/**
 * Normalize plugin install intents to skill file installs.
 *
 * @access private
 * @param {PluginInstallIntent[]} intents - Plugin install intents collected during runtime activation.
 * @returns {SkillInstall[]} Skill file installs keyed by skill name, with later intents replacing earlier duplicates.
 */
function skillInstalls(intents) {
  /** @type {Map<string, SkillInstall>} */
  const byName = new Map();
  for (const intent of intents) {
    for (const spec of intent.spec?.skills ?? []) {
      if (spec?.name && spec?.source) {
        byName.set(spec.name, {
          plugin: intent.plugin,
          name: spec.name,
          source: spec.source,
          sourceBase: intent.sourceBase
        });
      }
    }
  }
  return [...byName.values()];
}

/**
 * Install one declared skill into `.agents/skills/<name>/SKILL.md`.
 *
 * @access private
 * @param {string} projectDir - Filesystem location used by `installSkill`.
 * @param {{ name: string, source: string, sourceBase?: string }} spec - Object fields used to build the normalized value.
 * @returns {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} Structured output from `installSkill`.
 */
function installSkill(projectDir, spec) {
  const source = path.resolve(spec.sourceBase ?? projectDir, spec.source);
  const dest = path.join(projectDir, SKILL_DIR, spec.name, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (err) {
    return {
      ok: false,
      code: 'SUMO_INSTALL_SOURCE_MISSING',
      reason: `could not read skill source ${source}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
    };
  }
  let before = '';
  try {
    before = fs.readFileSync(dest, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        ok: false,
        code: 'SUMO_CONFIG_READ',
        reason: `could not read ${dest}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
      };
    }
  }
  if (before === text) {
    return {
      ok: true,
      changed: false,
      path: dest
    };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  return {
    ok: true,
    changed: true,
    path: dest
  };
}

/**
 * Inspect whether one generated skill install is current.
 *
 * @access private
 * @param {string} projectDir - Filesystem location used by `inspectSkill`.
 * @param {{ name: string, source: string, sourceBase?: string }} spec - Object fields used to build the normalized value.
 * @returns {SkillInspection} Skill drift status or read diagnostic.
 */
function inspectSkill(projectDir, spec) {
  const source = path.resolve(spec.sourceBase ?? projectDir, spec.source);
  const dest = path.join(projectDir, SKILL_DIR, spec.name, 'SKILL.md');
  let sourceText;
  try {
    sourceText = fs.readFileSync(source, 'utf8');
  } catch (err) {
    return {
      ok: false,
      code: 'SUMO_INSTALL_SOURCE_MISSING',
      reason: `could not read skill source ${source}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
    };
  }
  let destText;
  try {
    destText = fs.readFileSync(dest, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        current: false,
        exists: false,
        hasFrontmatter: false
      };
    }
    return {
      ok: false,
      code: 'SUMO_CONFIG_READ',
      reason: `could not read ${dest}: ${/** @type {NodeJS.ErrnoException} */ (err).message}`
    };
  }
  return {
    ok: true,
    current: destText === sourceText,
    exists: true,
    hasFrontmatter: SKILL_FRONTMATTER.test(destText)
  };
}

/**
 * Start the runtime once, collect plugin-owned install intents plus startup diagnostics, then stop it.
 *
 * @access private
 * @param {{ projectDir: string, flags?: object, env?: NodeJS.ProcessEnv, db?: import('sumo/db').SumoDb }} opts - Options read by this operation.
 * @returns {Promise<CollectedInstallIntents>} Runtime diagnostics plus the install intents declared by active plugins.
 */
async function collectInstallIntents({ projectDir, flags = {}, env = process.env, db }) {
  const rt = plugin({
    cwd: projectDir,
    flags,
    env,
    db
  });
  await rt.start();
  try {
    return {
      diagnostics: /** @type {InstallDiagnostic[]} */ (rt.diagnostics()),
      intents: /** @type {PluginInstallIntent[]} */ (rt.installIntents())
    };
  } finally {
    await rt.stop();
  }
}

/**
 * Reconcile full project setup.
 *
 * @access public
 * @param {{ projectDir?: string, yes?: boolean, flags?: object, env?: NodeJS.ProcessEnv, db?: import('sumo/db').SumoDb, out?: (s: string) => void }} opts - Options read by this operation.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `installProject`.
 */
export async function installProject({ projectDir = process.cwd(), yes = false, flags = {}, env = process.env, db, out = () => {} } = {}) {
  projectDir = path.resolve(projectDir);
  if (!yes) {
    out(`would reconcile Sumo project setup under ${projectDir} (hooks, plugin install intents, MCP); re-run with --yes to apply`);
    return 0;
  }

  const cfg = resolve({
    cwd: projectDir,
    flags: /** @type {Record<string, unknown> & { config?: string }} */ (flags),
    env
  });
  if (cfg.diagnostics.some((d) => d.severity === 'error')) {
    reportDiagnostics(cfg.diagnostics, out);
    return 1;
  }

  const loaded = await collectInstallIntents({
    projectDir,
    flags,
    env,
    db
  });
  if (loaded.diagnostics.some((d) => d.severity === 'error')) {
    reportDiagnostics(loaded.diagnostics, out);
    return 1;
  }

  for (const [id, installer] of Object.entries(HOOK_INSTALLERS)) {
    const r = installer.install({
      projectDir,
      env
    });
    if (!r.ok) {
      reportDiagnostics([r], out);
      return 1;
    }
    out(`${r.changed ? 'installed' : 'already up to date'}: ${id} hooks (${r.path})`);
    for (const warning of r.warnings ?? []) out(`warning: ${warning}`);
  }

  for (const spec of skillInstalls(loaded.intents)) {
    const r = installSkill(projectDir, spec);
    if (!r.ok) {
      reportDiagnostics([r], out);
      return 1;
    }
    out(`${r.changed ? 'installed' : 'already up to date'}: skill ${spec.name} (${r.path})`);
  }

  for (const rel of JSON_MCP_FILES) {
    const r = installMcpFile(path.join(projectDir, rel));
    if (!r.ok) {
      reportDiagnostics([r], out);
      return 1;
    }
    out(`${r.changed ? 'installed' : 'already up to date'}: MCP ${rel}`);
  }
  const codexMcp = installCodexMcpFile(path.join(projectDir, CODEX_MCP_FILE));
  if (!codexMcp.ok) {
    reportDiagnostics([codexMcp], out);
    return 1;
  }
  out(`${codexMcp.changed ? 'installed' : 'already up to date'}: MCP ${CODEX_MCP_FILE}`);
  return 0;
}

/**
 * Compute project setup drift diagnostics for doctor.
 *
 * @access public
 * @param {{ projectDir?: string, flags?: object, env?: NodeJS.ProcessEnv, installIntents?: PluginInstallIntent[] }} opts - Project location, config flags, and optional pre-collected plugin intents.
 * @returns {InstallDiagnostic[]} Drift diagnostics for missing hooks, MCP config, and plugin skill installs.
 */
export function projectDrift({ projectDir = process.cwd(), flags = {}, env = process.env, installIntents = [] } = {}) {
  projectDir = path.resolve(projectDir);
  const cfg = resolve({
    cwd: projectDir,
    flags: /** @type {Record<string, unknown> & { config?: string }} */ (flags),
    env
  });
  if (!cfg.config.root && (!Array.isArray(cfg.config.use) || cfg.config.use.length === 0)) return [];

  /** @type {InstallDiagnostic[]} */
  const diagnostics = [];
  for (const [id, installer] of Object.entries(HOOK_INSTALLERS)) {
    const marker = installer.SENTINEL ?? installer.HOOK_SENTINEL;
    let text = '';
    try {
      text = fs.readFileSync(installer.path(projectDir), 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        diagnostics.push({
          code: 'SUMO_INSTALL_DRIFT',
          message: `could not inspect ${id} hooks: ${/** @type {NodeJS.ErrnoException} */ (err).message}`,
          severity: 'error',
          source: {}
        });
      }
    }
    if (!marker || !text.includes(marker)) {
      diagnostics.push({
        code: 'SUMO_INSTALL_DRIFT',
        message: `missing Sumo ${id} hook config`,
        severity: 'error',
        source: {}
      });
    }
  }
  for (const spec of skillInstalls(installIntents)) {
    const inspected = inspectSkill(projectDir, spec);
    if (!inspected.ok) {
      diagnostics.push({
        code: inspected.code,
        message: inspected.reason,
        severity: 'error',
        source: {
          plugin: spec.plugin
        }
      });
    } else if (!inspected.exists) {
      diagnostics.push({
        code: 'SUMO_INSTALL_DRIFT',
        message: `plugin '${spec.plugin}' install intent missing skill '${spec.name}'`,
        severity: 'error',
        source: {
          plugin: spec.plugin
        }
      });
    } else if (!inspected.hasFrontmatter) {
      diagnostics.push({
        code: 'SUMO_INSTALL_DRIFT',
        message: `plugin '${spec.plugin}' install intent skill '${spec.name}' is missing YAML frontmatter`,
        severity: 'error',
        source: {
          plugin: spec.plugin
        }
      });
    } else if (!inspected.current) {
      diagnostics.push({
        code: 'SUMO_INSTALL_DRIFT',
        message: `plugin '${spec.plugin}' install intent skill '${spec.name}' is out of date`,
        severity: 'error',
        source: {
          plugin: spec.plugin
        }
      });
    }
  }
  for (const rel of JSON_MCP_FILES) {
    const file = path.join(projectDir, rel);
    if (!hasMcp(file)) {
      diagnostics.push({
        code: 'SUMO_INSTALL_DRIFT',
        message: `missing Sumo MCP server in ${rel}`,
        severity: 'error',
        source: {}
      });
    }
  }
  if (!hasCodexMcp(path.join(projectDir, CODEX_MCP_FILE))) {
    diagnostics.push({
      code: 'SUMO_INSTALL_DRIFT',
      message: `missing Sumo MCP server in ${CODEX_MCP_FILE}`,
      severity: 'error',
      source: {}
    });
  }
  return diagnostics;
}
