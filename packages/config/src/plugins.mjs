/**
 * Per-plugin config validation (spec 06 "Per-plugin config validation"). A plugin declares its zod
 * schema (`plugin.sumo.config`); Sumo validates the `plugins.<name>` slice BEFORE the plugin would be
 * called, and the validated slice **is** the plugin's `options`. A missing/invalid slice for an
 * enabled plugin marks it `unavailable` with a reason in diagnostics — never a crash.
 *
 * This module does not load plugins or read declared schemas off functions (that is the plugin
 * runtime's job, spec 03). It takes a `name → zod schema` registry so it stays a pure function the
 * runtime can feed.
 *
 * @module sumo/config/plugins
 */

/**
 * @typedef {Record<string, import('zod').ZodType>} PluginSchemaRegistry
 * @typedef {{
 *   use?: unknown,
 *   plugins?: unknown,
 *   pluginSchemas?: PluginSchemaRegistry,
 *   sources?: Record<string, string|undefined>
 * }} ValidatePluginsInput
 */

/**
 * Render a zod error's issues into a single human-readable reason string.
 *
 * @access private
 * @param {import('zod').ZodError} error - Validation error produced by `safeParse`.
 * @returns {string} Human-readable summary of the zod issues.
 */
function reasonFrom(error) {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate each enabled plugin's config slice against its declared schema.
 *
 * @access public
 * @param {ValidatePluginsInput} opts - Inputs needed to validate enabled plugin slices.
 * @returns {{ plugins: Record<string, import('./schema.mjs').PluginResolution>, diagnostics: import('./schema.mjs').DiagnosticSchema[] }} Structured output from `validatePlugins`.
 */
export function validatePlugins({ use, plugins, pluginSchemas = {}, sources = {} }) {
  /** @type {Record<string, import('./schema.mjs').PluginResolution>} */
  const resolutions = {};
  /** @type {import('./schema.mjs').DiagnosticSchema[]} */
  const diagnostics = [];

  // Boundary guard: this is called by the plugin runtime with a possibly-unvalidated merged config,
  // so tolerate a malformed `use`/`plugins` instead of throwing (the resolver reports the diagnostic).
  const enabled = /** @type {string[]} */ (Array.isArray(use) ? use.filter((name) => typeof name === 'string') : []);
  const slices = /** @type {Record<string, unknown>} */ (
    plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? plugins : {}
  );

  for (const name of enabled) {
    const slice = slices[name] ?? {};
    const schema = pluginSchemas[name];

    // No declared schema available (e.g. plugin not yet loaded): pass the raw slice through as
    // options. The runtime validates once schemas are known; this layer cannot validate blind.
    if (!schema) {
      resolutions[name] = { available: true, options: slice };
      continue;
    }

    const r = schema.safeParse(slice);
    if (r.success) {
      resolutions[name] = { available: true, options: r.data };
    } else {
      const reason = reasonFrom(r.error);
      resolutions[name] = { available: false, reason };
      diagnostics.push({
        code: 'SUMO_PLUGIN_CONFIG_INVALID',
        message: `plugin "${name}" config is invalid: ${reason}`,
        severity: 'error',
        source: { plugin: name, ...(sources[name] ? { file: sources[name] } : {}) }
      });
    }
  }

  return { plugins: resolutions, diagnostics };
}
