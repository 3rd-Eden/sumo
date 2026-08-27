/**
 * The MCP generator (spec 16): a Model Context Protocol server that is a pure PROJECTION of the
 * plugin runtime's capability catalog. It does not hand-author a tool list — it reads
 * `runtime.capabilities()`, filters to the `'mcp'` surface, and exposes each capability as an MCP
 * tool. `CallTool` routes straight back through `runtime.invoke(name, args, { surface:'mcp' })`, so
 * an MCP client hits the exact same `exec` the CLI and programmatic surfaces do.
 *
 * Unary only — there is no streaming tool (live following is `on()`/`db.subscribe`, not a capability;
 * spec 16 "non-goals").
 *
 * @module sumo/mcp/server
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { unwrapNestedResult } from 'sumo/error';
import { VERSION } from '../../../src/version.mjs';

const instructions = readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');

/** An MCP tool's `inputSchema` must be a JSON-Schema object; an absent capability schema → open object. */
const OPEN_INPUT = { type: 'object', properties: {}, additionalProperties: true };

/**
 * @typedef {Record<string, unknown> & { type?: string }} JsonSchemaObject
 * @typedef {{ code?: string, message?: string }} Diagnostic
 * @typedef {{
 *   name: string,
 *   title?: string,
 *   description?: string,
 *   surfaces: string[],
 *   inputSchema?: JsonSchemaObject,
 *   outputSchema?: JsonSchemaObject,
 *   annotations?: Record<string, unknown>
 * }} CapabilityEntry
 * @typedef {object} McpRuntime
 * @property {() => CapabilityEntry[]} capabilities - Return the current capability catalog.
 * @property {(name: string, args?: Record<string, unknown>, ctxOpts?: { surface: 'mcp', print: (text: string) => number, warn: (diagnostic: Diagnostic) => number }) => Promise<import('sumo/error').Result<unknown>>} invoke - Invoke a capability through the MCP surface.
 */

/**
 * MCP requires a tool's `inputSchema`/`outputSchema` to be a ROOT object JSON Schema. A capability is
 * free to declare any zod schema (it may be programmatic-first); only its MCP projection is
 * constrained. Return the schema when it is a root object, else `undefined` so the caller can degrade
 * (open input / omit output) instead of emitting a tool the SDK client would reject — which would
 * fail `ListTools` for EVERY tool, not just this one.
 *
 * @access private
 * @param {unknown} js - Js inspected by `asObjectSchema`.
 * @returns {JsonSchemaObject|undefined} Root object JSON Schema accepted by MCP, when present.
 */
function asObjectSchema(js) {
  const schema = js && typeof js === 'object' && !Array.isArray(js) ? /** @type {JsonSchemaObject} */ (js) : undefined;
  return schema?.type === 'object' ? schema : undefined;
}

/**
 * True only for a plain object (`{}`/`Object.create(null)`) — not Date/Map/Array/class instances.
 *
 * @access private
 * @param {unknown} v - V inspected by `isPlainObject`.
 * @returns {v is Record<string, unknown>} True when `v` is a plain object record.
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Build an MCP `Server` that serves the runtime's `'mcp'`-surfaced capabilities as tools. The catalog
 * is read on every `ListTools` so newly registered capabilities appear without a restart.
 *
 * @access public
 * @param {McpRuntime} runtime - Runtime capability catalog and invocation surface.
 * @param {{ name?: string, version?: string }} opts - MCP server identity metadata.
 * @returns {import('@modelcontextprotocol/sdk/server/index.js').Server} MCP server exposing runtime capabilities as tools.
 */
export function create(runtime, { name = 'sumo', version = VERSION } = {}) {
  const server = new Server({ name, version }, { capabilities: { tools: {} }, instructions });

  /**
   * Read the current MCP-visible capability catalog from the live plugin runtime.
   *
   * @access public
   * @returns {CapabilityEntry[]} Runtime capabilities available on the MCP surface.
   */
  function mcpCatalog() {
    return runtime.capabilities().filter((c) => c.surfaces.includes('mcp'));
  }

  server.setRequestHandler(ListToolsRequestSchema,async () => ({
    tools: mcpCatalog().map((c) => {
      const outputSchema = asObjectSchema(c.outputSchema);
      return {
        name: c.name, title: c.title, description: c.description,
        // Degrade a non-root-object input schema to an open object so one capability's exotic schema
        // cannot break ListTools for all tools (the capability's real zod schema still validates in invoke).
        inputSchema: asObjectSchema(c.inputSchema) ?? OPEN_INPUT,
        ...(outputSchema ? { outputSchema } : {}),
        ...(c.annotations ? { annotations: c.annotations } : {})
      };
    })
  }));

  server.setRequestHandler(CallToolRequestSchema,async (req) => {
    const { name: tool, arguments: args = {} } = req.params;
    /** @type {string[]} */
    const prints = [];
    /** @type {Diagnostic[]} */
    const warnings = [];
    const result = await runtime.invoke(tool, args, {
      surface: 'mcp',
      /**
       * Capture command prints as MCP text content items.
       *
       * @access public
       * @param {string} text - Text emitted by a capability through `ctx.print`.
       * @returns {number} Updated print count.
       */
      print(text) { return prints.push(text); },
      /**
       * Collect command warnings for MCP error-content rendering.
       *
       * @access public
       * @param {Diagnostic} d - Diagnostic emitted by a capability through `ctx.warn`.
       * @returns {number} Updated warning count.
       */
      warn(d) { return warnings.push(d); }
    });
    return toCallToolResult(result, prints, warnings);
  });

  return server;
}

/**
 * Map a Sumo `Result` (from `invoke`) onto an MCP `CallToolResult`. Mirrors the CLI's one-level
 * unwrap (a capability that returns its own `Result` reads correctly). A failure is reported as
 * `isError: true` with the stable `SUMO_*` code in the text — never thrown, never silent (§3b).
 *
 * @access private
 * @param {import('sumo/error').Result<unknown>} result - Runtime invocation result.
 * @param {string[]} prints - Text emitted by the capability while it ran.
 * @param {Diagnostic[]} warnings - Warning diagnostics emitted by the capability.
 * @returns {import('@modelcontextprotocol/sdk/types.js').CallToolResult} MCP call result with text content and optional structured content.
 */
function toCallToolResult(result, prints, warnings) {
  const r = /** @type {import('sumo/error').Result<unknown>} */ (unwrapNestedResult(result));

  if (r.ok !== true) {
    const lines = [`${r.code}: ${r.reason}`, ...warnings.map((d) => `${d.code ?? 'SUMO'}: ${d.message ?? ''}`)];
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }

  const value = r.value;
  /** @type {string[]} */
  const textParts = [];
  for (const p of prints) textParts.push(p);
  if (value !== undefined) textParts.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  if (!textParts.length) textParts.push('ok');
  for (const d of warnings) textParts.push(`${d.code ?? 'SUMO'}: ${d.message ?? ''}`);

  /** @type {import('@modelcontextprotocol/sdk/types.js').CallToolResult} */
  const res = { content: [{ type: 'text', text: textParts.join('\n') }], isError: false };
  // Structured output: only a PLAIN object qualifies as MCP `structuredContent` (a record). A Date,
  // Map, class instance, or array would fail the SDK's structuredContent validation and turn a
  // successful command into a protocol error — so they travel as text only.
  if (isPlainObject(value)) res.structuredContent = value;
  return res;
}
