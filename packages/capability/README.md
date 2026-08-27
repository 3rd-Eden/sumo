# `sumo/capability` — the capability contract

A **capability is defined once** in a rich shape; the CLI, MCP, and programmatic surfaces are
generated projections of that one definition, so every front door hits the same `exec`. This package
owns only the contract: the shape, its validator, and the serializable catalog entry the generators
read. It is pure zod code with no `plugin`, `db`, or `cli` dependency. Imported as `sumo/capability`
and re-exported from `sumo/plugin`.

## The shape — `create(obj)`

```js
create({
  name,               // unique id; the CLI subcommand AND the MCP tool name derive from it
  title,              // human display name (CLI help heading, MCP tool title)
  description,        // read by humans (CLI help) AND an LLM (MCP tool description)
  inputSchema?,       // OPTIONAL ZodType → CLI flags, MCP inputSchema, validation. ABSENT = pass-through
  outputSchema?,      // optional ZodType → MCP structuredContent + future journey assertions
  surfaces = ['cli','mcp','programmatic'],   // restrict where the capability appears
  annotations?,       // optional, DECLARATIVE-only MCP hints (readOnly/destructive/idempotent/openWorld)
  async exec(input, ctx) {}   // the ONE implementation; returns RAW DATA (not a Result)
})
```

`create` validates the shape (a bad shape is a programmer error and **throws**), applies defaults
(e.g. `surfaces`), and returns the object **deep-frozen** (`surfaces`/`annotations` too) so
the registered definition is the immutable source of truth for surface gating. The `definePlugin`-style
identity helper.

Capabilities are **unary**: `exec(input, ctx)` returns a value; the runtime's `invoke()` wraps it in
`ok(...)` and the surfaces render. There is no streaming mode. Live following is a subscription
(`on()` / `db.subscribe`), not a capability.

## The catalog entry — `toJSON(cap, { plugin })`

Projects a capability into its **serializable** catalog entry, the single source of truth the
generators (and the future journey-codifier) read:

```
{ name, title, description,
  inputSchema?  : JSON Schema (draft 2020-12, via zod 4 native z.toJSONSchema()),
  outputSchema? : JSON Schema,
  surfaces, plugin?, annotations? }
```

`surfaces`/`annotations` are returned as fresh copies (a catalog consumer cannot reach back into the
frozen definition). A zod schema that cannot be represented degrades to `undefined` rather than
throwing — one exotic schema must not break the whole catalog.

## Exports

`create`, `toJSON`, `CapabilitySchema`, `EntrySchema`, and `SURFACES`.

## Development

```bash
node --test packages/capability/test/capability.test.mjs
```
