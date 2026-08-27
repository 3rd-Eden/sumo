/**
 * `resolve` — the config resolution chain (spec 06). A pure function: inputs (cwd, flags, env,
 * the filesystem, and an optional plugin-schema registry) → a validated merged config + a
 * `DiagnosticSchema[]` + per-plugin resolutions. The only I/O is reading config files (discover.mjs).
 *
 * Resolution order (later overrides earlier): global → parent projects (top-most first) → nearest →
 * env (`SUMO_*`) → flags. Validation collects ALL errors as diagnostics; it never throws on the
 * first error (CONVENTIONS §3b #4) and never crashes on a bad plugin slice.
 *
 * @module sumo/config/resolve
 */

import { loadChain } from './discover.mjs';
import { mergeChain, mergeConfig } from './merge.mjs';
import { applyEnv } from './env.mjs';
import { validatePlugins } from './plugins.mjs';
import { ConfigSchema } from './schema.mjs';

/**
 * @typedef {{ file: string, data: Record<string, unknown> }} ConfigLayer
 * @typedef {{ blocks: Record<string, string>, plugins: Record<string, string> }} Provenance
 * @typedef {{
 *   cwd?: string,
 *   flags?: Record<string, unknown> & { config?: string },
 *   env?: NodeJS.ProcessEnv,
 *   pluginSchemas?: Record<string, import('zod').ZodType>
 * }} ResolveInput
 */

/**
 * Record, per top-level block and per `plugins.<name>` slice, the last file that contributed it —
 * so a validation diagnostic can point at the file the user must edit.
 *
 * @access private
 * @param {ConfigLayer[]} layers - Layers supplied to `provenance`.
 * @returns {Provenance} Per-block and per-plugin provenance mapping.
 */
function provenance(layers) {
  /** @type {Record<string, string>} */
  const blocks = {};
  /** @type {Record<string, string>} */
  const plugins = {};
  for (const { file, data } of layers) {
    for (const key of Object.keys(data)) blocks[key] = file;
    if (data.plugins && typeof data.plugins === 'object') {
      for (const name of Object.keys(data.plugins)) plugins[name] = file;
    }
  }
  return { blocks, plugins };
}

/**
 * Resolve the effective Sumo configuration for a working directory.
 *
 * @access public
 * @param {ResolveInput} input - Resolver inputs from CLI flags, environment, and optional schemas.
 * @returns {import('./schema.mjs').ResolveResult} Shared Result returned by `resolve`.
 */
export function resolve({
  cwd = process.cwd(),
  flags = {},
  env = process.env,
  pluginSchemas = {}
} = {}) {
  const { layers, diagnostics } = loadChain({ cwd, flags, env });
  const sources = provenance(layers);

  // global → parents → nearest, then env, then flags (minus the discovery-only `config` key).
  const mergedFiles = mergeChain(layers.map((l) => l.data));
  const withEnv = applyEnv(mergedFiles, env);
  const { config: _ignoredConfigFlag, ...flagOverrides } = /** @type {Record<string, unknown> & { config?: string }} */ (flags);
  const merged = mergeConfig(withEnv, flagOverrides);

  // Validate the core blocks. On failure we still return the merged object (best effort) so the
  // resolver never throws; the diagnostics tell the user what to fix.
  const parsed = ConfigSchema.safeParse(merged);
  const config = /** @type {import('./schema.mjs').ResolvedConfig} */ (parsed.success ? parsed.data : merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const block = issue.path[0];
      const file = typeof block === 'string' ? sources.blocks[block] : undefined;
      diagnostics.push({
        code: 'SUMO_CONFIG_INVALID', message: `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`, severity: 'error', source: file ? { file } : {}
      });
    }
  }

  // Validate each enabled plugin's slice against its declared schema. When core validation failed we
  // fall back to the raw merged object, whose `use`/`plugins` may be the wrong type — coerce to safe
  // shapes here so a bad config produces diagnostics, never a crash (spec 06 / CONVENTIONS §3b #4).
  const use = Array.isArray(config.use) ? config.use.filter((name) => typeof name === 'string') : [];
  const pluginBag =
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? config.plugins
      : {};
  const { plugins, diagnostics: pluginDiags } = validatePlugins({
    use,
    plugins: pluginBag,
    pluginSchemas,
    sources: sources.plugins
  });
  diagnostics.push(...pluginDiags);

  return { config, diagnostics, plugins };
}
