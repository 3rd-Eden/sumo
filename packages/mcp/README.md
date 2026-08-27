# `sumo/mcp` — MCP tools generated from capabilities

This package exposes Sumo to **Model Context Protocol** clients. It owns the MCP
transport/protocol boundary and projects the shared capability catalog as tools; the behavior still
lives in the packages that register those capabilities. That keeps CLI, MCP, and programmatic
surfaces aligned through the same definitions.

It uses the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol), is
imported as `sumo/mcp`, and is launched by `sumo mcp` over stdio.

## Server Behavior

The server is a low-level SDK `Server` with handlers derived from `runtime.capabilities()`:

- **`ListTools`** exposes only catalog entries that include the `mcp` surface. Tool
  `name`, `title`, `description`, `inputSchema`, and `annotations` come from the capability
  definition. Programmatic-only capabilities are not exposed.
- **`CallTool`** invokes the same executor used by CLI and programmatic callers:
  `runtime.invoke(name, args, { surface: 'mcp' })`.
- **Result mapping** turns successful results into text content, marks failed `Result` values with
  `isError`, and includes `structuredContent` only when the value is a plain object.
- **Interaction gating** returns `SUMO_NO_INTERACTION` for `ctx.ask(...)` because MCP is
  non-interactive. Unknown tools or wrong-surface tools return `SUMO_NO_COMMAND` or
  `SUMO_SURFACE_UNSUPPORTED`.

MCP tools are unary. Live following belongs to event subscriptions (`on()` / `db.subscribe`), not to
capability calls.

## Run It

Configure an MCP client to start:

```sh
sumo mcp
```

The process speaks MCP over stdio. Users normally see tools in the MCP client, not terminal output.

<details>
<summary>Example client-visible tools</summary>

```text
sessions
session-spawn
session-await-turn
harnesses
models
work.detect
work.claim
```

</details>

<details>
<summary>Generated Tool Model</summary>

A capability registered with `surfaces: ['mcp']` becomes one MCP tool. The capability schema is the
source of truth:

```js
defineCapability({
  name: 'session-spawn',
  description: 'Spawn a new harness session',
  surfaces: ['cli', 'mcp', 'programmatic'],
  inputSchema,
  outputSchema,
  exec: async (input, ctx) => { /* ... */ }
});
```

The MCP projection does not hand-write a second tool implementation. It adapts the capability's
JSON Schema and forwards calls into `exec`.

</details>

## Exports

- `createMcpServer(runtime, { name?, version? })` → a connected-ready SDK `Server` projecting the
  catalog. Connect it to any transport (tests use the SDK's in-memory linked pair).
- `serveMcp(runtime, { name?, version?, transport? })` → connects the server (stdio by default) and
  resolves to it; the `sumo mcp` launch path.

## Development

```bash
node --test packages/mcp/test/mcp.test.mjs        # against a REAL MCP Client over in-memory transport
node --test packages/mcp/test/keystone.test.mjs   # one capability, identical via CLI / MCP / programmatic
```
