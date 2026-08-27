/**
 * `sumo/mcp` — the MCP server surface (spec 16, closes gap ). An external MCP client drives Sumo
 * through tools that are GENERATED projections of the capability catalog; `sumo mcp` launches it over
 * stdio. The server itself is concern-focused (CONVENTIONS §3d): it owns the MCP transport/protocol
 * and nothing else — all behaviour lives in the capabilities it projects.
 *
 * @module sumo/mcp
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { create } from './server.mjs';

export { create } from './server.mjs';

/**
 * Connect an MCP server for `runtime` to a stdio transport (the `sumo mcp` launch path). Resolves to
 * the connected server; the process stays alive on the transport until the client disconnects.
 *
 * @access public
 * @param {import('./server.mjs').McpRuntime} runtime - Runtime used by the surface.
 * @param {{ name?: string, version?: string, transport?: import('@modelcontextprotocol/sdk/shared/transport.js').Transport }} opts - Server metadata and optional transport.
 * @returns {Promise<unknown>} Promise resolving to the `serve` result.
 */
export async function serve(runtime, { name, version, transport } = {}) {
  const server = create(runtime, { name, version });
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}
