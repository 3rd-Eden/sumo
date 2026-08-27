/**
 * Canonical contracts for the plugin runtime (specs 03 / 03a). These zod schemas + helpers are the
 * single source of truth; the JSDoc typedefs are descriptions of them (CONVENTIONS §3).
 *
 * What lives here:
 * - the shared `Result` envelope + `ok`/`fail` helpers (CONVENTIONS §3b aligned #1/#4);
 * - the stable `SUMO_*` capability/diagnostic codes the runtime surfaces;
 * - the plugin declaration (`plugin.sumo`) and verb option shapes the runtime introspects;
 * - JSDoc typedefs for the objects handed INTO plugins (`SumoEvent`/`SteerEvent`/`InvocationCtx`/
 *   `Store`/`Work`/`Session`, 03a) so editors and `tsc --checkJs` can lint without a build step.
 *
 * @module sumo/plugin/schema
 */

import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';

export { ok, fail, isResult, CAP_UNSUPPORTED };

// ── Codes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Stable codes the runtime emits. CapabilitySchema-absence (`SUMO_NO_*`) and unsupported declared
 * operations (`SUMO_CAP_UNSUPPORTED`) are returned as a failed `Result` and surfaced as a
 * `DiagnosticSchema` — never thrown, never a silent no-op (CONVENTIONS §3b aligned #2).
 */
export const ErrorSchema = z.enum([
 'SUMO_NO_HARNESS', // sumo.run(...) with no registered or available harness
 'SUMO_NO_MESSENGER', // a messenger-bound op with no messenger registered
 'SUMO_NO_INTERACTION', // ctx.ask(...) on a non-interactive surface (MCP/headless)
 'SUMO_CAP_UNSUPPORTED', // an adapter declares (via can) it cannot do this op
 'SUMO_PLUGIN_DEP_MISSING', // a declared plugin.sumo.plugins dependency is absent (install is layer 13)
 'SUMO_PLUGIN_CYCLE', // a cycle among declared plugin dependencies (broken + reported)
 'SUMO_PLUGIN_CONFIG_INVALID', // a plugin's config slice failed its declared schema
 'SUMO_PLUGIN_DECL_INVALID', // a plugin's static `plugin.sumo` marker is malformed
 'SUMO_PLUGIN_LOAD', // a module-specifier plugin failed to import
 'SUMO_PLUGIN_ACTIVATE', // a plugin threw during activation (its registrations were rolled back)
 'SUMO_NO_COMMAND', // invoke(name) for a command that was never registered
 'SUMO_NO_SKILL', // skill.run(name) for a skill that was never registered
 'SUMO_SKILL_FAILED', // a registered skill threw while executing
 'SUMO_COMMAND_INPUT_INVALID', // command args failed the command's declared input schema
 'SUMO_SURFACE_UNSUPPORTED', // invoke(name, …, {surface}) for a surface the capability does not declare
 'SUMO_QUEUE_BACKPRESSURE' // the event delivery queue exceeded its soft high-water mark (warning)
]);

/** @typedef {'SUMO_NO_HARNESS'|'SUMO_NO_MESSENGER'|'SUMO_NO_INTERACTION'|'SUMO_CAP_UNSUPPORTED'|'SUMO_PLUGIN_DEP_MISSING'|'SUMO_PLUGIN_CYCLE'|'SUMO_PLUGIN_CONFIG_INVALID'|'SUMO_PLUGIN_DECL_INVALID'|'SUMO_PLUGIN_LOAD'|'SUMO_PLUGIN_ACTIVATE'|'SUMO_NO_COMMAND'|'SUMO_NO_SKILL'|'SUMO_SKILL_FAILED'|'SUMO_COMMAND_INPUT_INVALID'|'SUMO_SURFACE_UNSUPPORTED'|'SUMO_QUEUE_BACKPRESSURE'} PluginErrorCodeT */

/**
 * The unified diagnostic shape (mirrors sumo/config's `DiagnosticSchema`; declared locally so it is a
 * type-only reference within this package rather than a cross-package value/type collision).
 * @typedef {object} Diagnostic
 * @property {string} code
 * @property {string} message
 * @property {'error'|'warning'} [severity]
 * @property {{ plugin?: string, file?: string, line?: number }} [source]
 */

/**
 * The shape of a plugin's static `plugin.sumo` marker (DeclSchema validates this at runtime; this is
 * its documentation type for property access).
 * @typedef {object} PluginDeclShape
 * @property {string} [name]
 * @property {Array<string|{ name: string, version?: string }>} [plugins]
 * @property {unknown} [config] - the plugin's zod schema for its `plugins.<id>` config slice
 */

// ── Result envelope (CONVENTIONS §3b aligned #1) ─────────────────────────────────────────────────

/**
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

// ── Plugin declaration + verb options (the runtime introspects these) ────────────────────────────

/**
 * A declared plugin install-dependency (): another Sumo plugin that must be present. Read off
 * `plugin.sumo.plugins` BEFORE activation. The runtime orders by it and diagnoses a missing one; the
 * actual install (pnpm devDeps) is the installation layer's job (spec 13).
 */
export const DepSchema = z.union([
z.string().min(1),
z.object({ name: z.string().min(1), version: z.string().optional() })
]);

/**
 * The static declaration a plugin attaches to its function (`plugin.sumo = {...}`), introspected
 * without running the plugin. `config` is the plugin's own zod schema for its `plugins.<id>` slice
 * (validated by sumo/config, not re-validated here). `name` is an explicit canonical id ().
 *
 * `z.any()` for `config` keeps this permissive — it is a zod schema instance, structurally validated
 * by use, not by this meta-schema.
 */
export const DeclSchema = z.object({
  name: z.string().min(1).optional(), plugins: z.array(DepSchema).optional(), config: z.any().optional()
});

/** Options accepted by `on`/`before` registration. `safety` (before only) flips fail-open→closed.
 *  `match` (before only, spec 12) narrows a decision hook to matching actions WITHOUT running the
 *  handler otherwise: a string/RegExp matches the tool name (`e.payload.tool.name`); a function is a
 *  predicate over the steer event. Engine-side filtering — `sumo forward` cannot match (registrations
 *  live daemon-side); native install-time matchers are a later optimization. */
export const HandlerSchema = z.object({
  priority: z.number().int().optional(), timeout: z.number().int().positive().optional(), safety: z.boolean().optional(), match: z
    .custom((v) => typeof v === 'string' || v instanceof RegExp || typeof v === 'function', {
      message: 'match must be a string (tool name), RegExp (tool-name pattern), or function (event predicate)'
    })
    .optional()
});

/** Default per-handler timeouts (). Numeric ms; overridable per handler (`opts.timeout`). */
export const STEER_TIMEOUT_MS = 5_000; // steering blocks the agent path — short
export const OBSERVE_TIMEOUT_MS = 20_000; // observers/transforms — the handler engine.s default

/** The reserved plugin id the runtime uses for its own KV (watermark, etc.); outside any plugin's space. */
export const RUNTIME_PLUGIN_ID = '__sumo_runtime__';

// ── JSDoc typedefs for objects handed INTO plugins (03a) ─────────────────────────────────────────

/**
 * A plugin is `function plugin(sumo, options)`, default-exported, that calls flat verbs.
 * `plugin.sumo` (DeclSchema) is the optional static marker introspected before activation.
 * @typedef {(sumo: SumoFacade, options: Record<string, unknown>) => void} SumoPlugin
 */

/**
 * Flat capability surface handed to a plugin during activation.
 * @typedef {object} SumoFacade
 * @property {(type: string, fn: Function, opts?: object) => void} on
 * @property {(action: string, fn: Function, opts?: object) => void} before
 * @property {(name: string, fn: Function, schema?: unknown) => void} command
 * @property {((name: string, fn: Function, meta?: object) => void) & { run: (name: string, context?: Record<string, unknown>) => Promise<Result> }} skill
 * @property {(name: string, impl: Function) => void} harness
 * @property {(name: string, impl: Function) => void} messenger
 * @property {(prompt: string, opts?: object) => Promise<Result<unknown>>} run
 * @property {(namespace?: string) => Store} store
 * @property {(type: string, payload?: Record<string, unknown>, opts?: object) => Promise<number>} emit
 */

/**
 * The observed event handed to `on(type, fn)` (03a §3). Bound helpers are wired by the runtime
 * (the producer), so the consumer never touches the daemon directly.
 * @typedef {object} SumoEvent
 * @property {number} seq
 * @property {number} ts
 * @property {string} type
 * @property {string} [sessionId]
 * @property {Record<string, unknown>} payload
 * @property {Record<string, unknown>} ext
 * @property {() => Promise<Session|undefined>} session - resolve the originating session when present
 * @property {() => Promise<Record<string, unknown>|undefined>} raw - the preserved raw record (via rawRef)
 * @property {(type: string, payload: Record<string, unknown>) => Promise<number>} emit - emit a derived event
 */

/**
 * The steering event handed to `before(action, fn)` (03a §4). The return value drives the waterfall
 * (`{deny}` / `{event}` / nothing); `can` lets a handler degrade instead of failing.
 * @typedef {object} SteerEvent
 * @property {string} action
 * @property {Record<string, unknown>} payload
 * @property {Record<string, unknown>} ext
 * @property {CapabilitiesSchema} can
 * @property {string} [sessionId] - the correlated Sumo ULID of the requesting session, when known
 * @property {() => Promise<Record<string, unknown>|undefined>} raw
 */

/**
 * The decision a `before` handler returns (03b "decision shape").
 * `inject` attaches additional context text to the harness response (mapped to
 * `additionalContext` / `additional_context` per harness). Compatible with both `deny` and
 * `event` — a denied tool call can carry coaching text alongside the block reason.
 * @typedef {void|undefined|{ event?: Record<string, unknown>, inject?: string }|{ deny: string, inject?: string }} SteerDecision
 */

/**
 * Second arg to a `command` handler (03a §5). Identical across CLI/MCP/programmatic surfaces.
 * @typedef {object} InvocationCtx
 * @property {'cli'|'mcp'|'programmatic'} surface
 * @property {string} cwd
 * @property {(text: string) => void} print
 * @property {(d: Diagnostic) => void} warn
 * @property {(prompt: string, opts?: object) => Promise<Result<string>>} ask - Result; SUMO_NO_INTERACTION off-CLI
 */

/**
 * The scoped KV handle returned by `store(ns)` (03a §6). Bound to `kv:<plugin>:<ns>:` and unable to
 * address another plugin's namespace.
 * @typedef {object} Store
 * @property {(key: string) => Promise<unknown|undefined>} get
 * @property {(key: string, value: unknown, opts?: { ttlMs?: number }) => Promise<void>} set
 * @property {(key: string) => Promise<void>} del
 * @property {(prefix?: string) => AsyncIterable<[string, unknown]>} scan
 * @property {(key: string, patch: Record<string, unknown>) => Promise<void>} merge - atomic read-merge-write via daemon serializer
 */

/**
 * Per-session capability descriptor — canonical definition in `sumo/session`.
 * @typedef {import('sumo/session').CapabilitiesSchema} CapabilitiesSchema
 */

/**
 * The session handle returned by `sumo.run(...)` — canonical definition in `sumo/session`.
 * @typedef {import('sumo/session').Session} Session
 */

/**
 * A unit of work produced by a messenger adapter, handed to `on('work', fn)` (03a §1). All methods
 * are pre-bound by the adapter to this work's origin; the consumer never names an adapter.
 * @typedef {object} Work
 * @property {string} id
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [cwd]
 * @property {Record<string, unknown>} ext
 * @property {(text: string) => Promise<unknown>} reply
 * @property {() => Promise<unknown>} claim
 * @property {() => Promise<unknown>} [heartbeat]
 * @property {(outcome: object) => Promise<unknown>} [release]
 * @property {(status: object) => Promise<unknown>} [status]
 * @property {(review: object) => Promise<unknown>} [review]
 * @property {(emoji: string) => Promise<unknown>} [react]
 * @property {(type: string, payload?: Record<string, unknown>) => Promise<unknown>} [emit]
 * @property {Record<string, boolean>} can
 */
