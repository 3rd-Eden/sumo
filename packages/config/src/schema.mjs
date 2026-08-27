/**
 * Canonical zod contracts for the config-resolution layer (spec 06). These schemas are the single
 * source of truth; the JSDoc typedefs below are descriptions of them (CONVENTIONS §3).
 *
 * The **core blocks** (`storage`/`daemon`/`harness`/`orchestrator`) are validated by `ConfigSchema`;
 * each `plugins.<name>` slice is validated by that plugin's own declared schema (see plugins.mjs).
 * Validation is a user-facing collection point: issues become `DiagnosticSchema`s rather than throwing
 * on the first error (spec 06 / CONVENTIONS §3b #4).
 *
 * @module sumo/config/schema
 */

import { z } from 'zod';

/** Stable diagnostic codes for the config layer, mapping to `DiagnosticSchema.code` (CONVENTIONS §7). */
export const ErrorSchema = z.enum([
  'SUMO_CONFIG_NOT_FOUND',
  'SUMO_CONFIG_READ',
  'SUMO_CONFIG_PARSE',
  'SUMO_CONFIG_INVALID',
  'SUMO_PLUGIN_CONFIG_INVALID'
]);

/**
 * The unified user-facing diagnostic (spec 06 "Validation = a user-facing collection point"). Every
 * config/plugin issue is reported as one of these with the layer/file that introduced it, instead of
 * throwing on the first error.
 */
export const DiagnosticSchema = z.object({
  code: z.string(), message: z.string(), severity: z.enum(['error', 'warning']).default('error'), source: z
    .object({
      file: z.string().optional(), plugin: z.string().optional(), line: z.number().int().nonnegative().optional()
    })
    .default({})
});

/**
 * A human duration string as written in YAML (`30m`, `10m`, `15s`, `1h`, `90d`, `500ms`). Kept as a
 * string here — parsing to milliseconds is a consumer concern (daemon/orchestrator), not config's.
 */
const Duration = z.string().regex(/^\d+\s*(ms|s|m|h|d)$/, 'expected a duration like "30m" or "15s"');

/** TTL sweeper retention defaults (spec 01/16). */
const Retention = z.object({
  rawDays: z.number().int().positive().optional(), eventDays: z.number().int().positive().optional()
});

/** Storage block — LevelDB directory + retention (spec 01). */
const Storage = z.object({
  path: z.string().optional(), retention: Retention.optional()
});

/** Daemon block (spec 02). `scope` expresses the per-request-cwd resolution context (spec 06). */
const Daemon = z.object({
  socket: z.string().optional(), idleShutdown: Duration.optional(), scope: z.enum(['project', 'global']).default('project')
});

/** Harness block (spec 05). Per-adapter config lives under the adapter id key (e.g. `harness['claude-code'].bin`). */
const Harness = z.object({
  default: z.string().optional(), fallback: z.array(z.string()).default([])
}).passthrough();

/** Orchestrator block — orchestrator vocabulary (spec 10). */
const Orchestrator = z.object({
  timeouts: z
    .object({
      stall: Duration.optional(), shutdown: Duration.optional(), rapidDeath: Duration.optional(), nudge: z.boolean().optional()
    })
    .optional(), guards: z
    .object({
      maxRounds: z.number().int().positive().optional()
    })
    .optional()
});

/**
 * The merged core configuration (spec 06 schema). Every block is optional/defaulted so a minimal or
 * empty `sumo.yml` validates cleanly. `plugins` is a passthrough bag here — each slice is validated
 * against the owning plugin's declared schema separately (plugins.mjs), never by this core schema.
 */
export const ConfigSchema = z.object({
  root: z.boolean().default(false), use: z.array(z.string()).default([]), storage: Storage.optional(),
  // prefault (not default): an omitted `daemon` is parsed as `{}` so the nested `scope` default
  // applies, rather than short-circuiting to a bare `{}` (zod v4 `.default()` does not re-parse).
  daemon: Daemon.prefault({}), harness: Harness.optional(), orchestrator: Orchestrator.optional(), plugins: z.record(z.string(), z.unknown()).default({})
});

/**
 * @typedef {object} DiagnosticSource
 * @property {string} [file]   - the config file that introduced the issue
 * @property {string} [plugin] - the plugin whose slice introduced the issue
 * @property {number} [line]   - 1-based line within `file`, when known
 */

/**
 * @typedef {object} DiagnosticSchema
 * @property {string} code                 - a stable `SUMO_*` code (see ErrorSchema)
 * @property {string} message              - human-readable description
 * @property {'error'|'warning'} severity
 * @property {DiagnosticSource} source
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean} root
 * @property {string[]} use
 * @property {{ path?: string, retention?: { rawDays?: number, eventDays?: number } }} [storage]
 * @property {{ socket?: string, idleShutdown?: string, scope: 'project'|'global' }} daemon
 * @property {{ default?: string, fallback?: string[] }} [harness] Default harness id and ordered fallback candidates for `sumo.run`.
 * @property {object} [orchestrator]
 * @property {Record<string, unknown>} plugins
 */

/**
 * @typedef {object} PluginResolution
 * @property {boolean} available           - false when an enabled plugin's slice failed validation
 * @property {unknown} [options]           - the validated slice IS the plugin's options (spec 06)
 * @property {string} [reason]             - why the plugin is unavailable
 */

/**
 * @typedef {object} ResolveResult
 * @property {ResolvedConfig} config
 * @property {DiagnosticSchema[]} diagnostics
 * @property {Record<string, PluginResolution>} plugins
 */
