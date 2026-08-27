/**
 * `sumo/capability` — the capability contract (spec 16). A **capability is defined once** in a rich
 * shape; the CLI, MCP, and programmatic surfaces are GENERATED projections of that one definition,
 * so every front door hits the same `exec`. This package owns ONLY the contract: the shape, its
 * validator (`create`), and the machine-readable **catalog entry** the generators read
 * (`toJSON`). It is pure — zod only, no plugin/db/cli dependencies (CONVENTIONS §3d).
 *
 * Capabilities are **unary**: `exec(input, ctx)` returns RAW DATA (not a `Result`). The plugin
 * runtime's `invoke()` wraps the return in `ok(...)`; the surfaces normalize/render. Live following
 * (`tail`) is a subscription/feed served by `on()` / `db.subscribe`, NOT a capability — there is no
 * streaming mode here (spec 16 "non-goals").
 *
 * @module sumo/capability
 */

import { z } from 'zod';
import { SumoError } from 'sumo/error';

/** The surfaces a capability can project onto. */
export const SURFACES = /** @type {const} */ (['cli', 'mcp', 'programmatic']);

/** A zod schema instance, duck-typed so the check is version-robust across zod releases. */
const ZodSchema = z.custom((v) => typeof (/** @type {Record<string, unknown>} */ (v)?.safeParse) === 'function', {
  message: 'must be a zod schema (got a value without .safeParse)'
});

/**
 * Declarative, MCP-aligned tool hints. NOT enforced by Sumo ( removed permissions from the
 * plugin system) — recorded and surfaced so an MCP client can render them. Unknown keys pass through.
 */
const Annotations = z
  .object({
    title: z.string().optional(), readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional()
  })
  .loose();

/**
 * The capability meta-schema — the single definition every surface derives from. `inputSchema` is
 * OPTIONAL: absent means "pass args through unvalidated" (preserving the thin `command(name, fn)`
 * form exactly). `surfaces` defaults to all three.
 */
export const CapabilitySchema = z.object({
  name: z.string().min(1), title: z.string().min(1), description: z.string(), inputSchema: ZodSchema.optional(), outputSchema: ZodSchema.optional(), surfaces: z.array(z.enum(SURFACES)).nonempty().default(['cli', 'mcp', 'programmatic']), annotations: Annotations.optional(), exec: z.custom((v) => typeof v === 'function', { message: 'exec must be a function' })
});

/**
 * The serializable catalog entry the generators (and the future journey-codifier) read. `inputSchema`
 * / `outputSchema` are emitted as JSON Schema (draft 2020-12) here, never the live zod instance.
 */
export const EntrySchema = z.object({
  name: z.string(), title: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.any()).optional(), outputSchema: z.record(z.string(), z.any()).optional(), surfaces: z.array(z.enum(SURFACES)), plugin: z.string().optional(), annotations: z.record(z.string(), z.any()).optional()
});

/**
 * @typedef {object} CapabilityDef
 * @property {string} name              - unique id; the CLI subcommand AND the MCP tool name
 * @property {string} title             - human display name (CLI help heading, MCP tool title)
 * @property {string} description       - read by humans (CLI help) AND an LLM (MCP tool description)
 * @property {import('zod').ZodTypeAny} [inputSchema]  - validates params; absent = pass-through
 * @property {import('zod').ZodTypeAny} [outputSchema] - documents the return shape
 * @property {Array<'cli'|'mcp'|'programmatic'>} surfaces
 * @property {Record<string, unknown>} [annotations]
 * @property {Function} exec      - the ONE implementation; each capability documents its own input and context
 */

/**
 * Validate a capability definition and return it (defaults applied, e.g. `surfaces`), frozen. A bad
 * shape is a programmer error (the author miswrote the definition), so this THROWS rather than
 * returning a `Result` (CONVENTIONS §3b). The `definePlugin`-style identity helper.
 *
 * @access public
 * @param {Partial<CapabilityDef> & { exec: Function }} def - Def supplied to `create`.
 * @returns {CapabilityDef} Capability def returned by `create`.
 */
export function create(def) {
  const parsed = CapabilitySchema.safeParse(def);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SumoError({ name: 'capability', method: 'create', code: 'SUMO_CAPABILITY_INVALID', message: `create: invalid capability '${def?.name ?? '(unnamed)'}': ${issues}` });
  }
  const cap = /** @type {CapabilityDef} */ (parsed.data);
  // Deep-freeze the gating-relevant nested data: `invoke()` reads `capability.surfaces` for surface
  // gating, so a mutable `surfaces` array would let a caller (e.g. via a catalog entry) change later
  // gating decisions. Freezing makes the registered definition the immutable source of truth.
  Object.freeze(cap.surfaces);
  if (cap.annotations) Object.freeze(cap.annotations);
  return Object.freeze(cap);
}

/**
 * Project a capability into its serializable catalog entry. The zod input/output schemas become JSON
 * Schema via zod 4's native `z.toJSONSchema()`. A schema that cannot be represented degrades to
 * `undefined` (the MCP tool gets an open object schema, the CLI gets no typed flags) rather than
 * throwing — one exotic plugin schema must not break the whole catalog.
 *
 * @access public
 * @param {CapabilityDef} cap - Cap supplied to `toJSON`.
 * @param {{ plugin?: string }} extra - Additional metadata.
 * @returns {import('zod').infer<typeof EntrySchema>} Import('zod') infer<typeof entry schema> returned by `toJSON`.
 */
export function toJSON(cap, extra = {}) {
  return {
    name: cap.name, title: cap.title, description: cap.description, inputSchema: toJsonSchema(cap.inputSchema), outputSchema: toJsonSchema(cap.outputSchema),
    // Fresh copies: the catalog is a projection/snapshot; a consumer sorting/filtering it must not be
    // able to reach back and mutate the (frozen) registered definition's `surfaces`/`annotations`.
    surfaces: [...cap.surfaces],
    ...(cap.annotations ? { annotations: { ...cap.annotations } } : {}),
    ...(extra.plugin ? { plugin: extra.plugin } : {})
  };
}

/**
 * Best-effort zod→JSON-Schema; `undefined` schema or an unrepresentable one yields `undefined`.
 *
 * @access private
 * @param {import('zod').ZodType|undefined} schema - Optional zod schema to project.
 * @returns {Record<string, unknown>|undefined} JSON Schema projection when zod can represent it.
 */
function toJsonSchema(schema) {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema);
  } catch {
    return undefined;
  }
}
