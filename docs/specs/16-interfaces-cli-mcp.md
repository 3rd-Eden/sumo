# 16 — Interfaces: one capability, many surfaces (CLI · MCP · programmatic)

This is the architecture's keystone made structural: **a capability is defined ONCE in a rich shape,
and the CLI, MCP, and programmatic surfaces are GENERATED projections of that one definition.** It
does not matter how a user (or an agent) invokes a capability — every front door routes through the
same `invoke()` to the same `exec`. There is no surface with behaviour another lacks, because none of
them hand-author behaviour: they all project from one catalog. This avoids CLI/MCP
surface) as a *generator over the catalog*, not a bespoke tool list.

## The one definition — `sumo/capability`

`defineCapability(obj)` (pure package, zod only — CONVENTIONS §3d) is the single registration shape:

```js
defineCapability({
  name,               // unique id; the CLI subcommand AND the MCP tool name derive from it
  title,              // human display name (CLI help heading, MCP tool title)
  description,        // read by humans (CLI help) AND an LLM (MCP tool description)
  inputSchema?,       // OPTIONAL ZodType → CLI flags, MCP inputSchema, validation. ABSENT = pass-through
  outputSchema?,      // optional ZodType → MCP structuredContent + future journey assertions
  surfaces = ['cli','mcp','programmatic'],   // restrict where the capability appears
  annotations?,       // optional, DECLARATIVE-only MCP hints (readOnly/destructive/idempotent/openWorld);
                      //   NOT enforced —  removed permissions from the plugin system
  async exec(input, ctx) {}   // the ONE implementation; returns RAW DATA (not a Result)
})
```

`defineCapability` validates the shape (a bad shape is a programmer error → throws, §3b), applies
defaults (e.g. `surfaces`), and returns the frozen object. `inputSchema` is **optional**: absent means
"pass args through unvalidated", which is exactly the legacy thin-`command` behaviour, preserved.

**Capabilities are unary.** `exec(input, ctx)` returns a value; `invoke()` wraps it in `ok(...)`; the
surfaces normalise/render. See **Non-goals** for why there is no streaming mode.

## The catalog — the single source of truth

`runtime.capabilities()` returns the machine-readable catalog the generators read — one entry per
registered capability, projected via `toCatalogEntry`:

```
{ name, title, description,
  inputSchema?  : JSON Schema (draft 2020-12, via zod 4 native z.toJSONSchema()),
  outputSchema? : JSON Schema,
  surfaces      : ('cli'|'mcp'|'programmatic')[],
  plugin        : owning plugin id,
  annotations?  : declarative hints }
```

The catalog is a **first-class, documented output**, not an afterthought: the CLI and MCP generators
read it (never re-deriving shapes independently), and the future journey-codifier (mermaid-graph →
test) reads exactly this to ask "does capability X exist and what is its shape." An input schema that
cannot be represented as JSON Schema degrades to `undefined` (open input) rather than breaking the
whole catalog.

## Registration — `command()` (rich + thin)

The plugin runtime's `command` verb accepts both forms, and the `commands` Map carries the full
capability so the catalog can project from it:

- **Rich:** `sumo.command(defineCapability({ … }))`.
- **Thin (sugar, unchanged):** `sumo.command(name, fn, schema?)` builds a minimal capability
  (`title = name`, empty description, all surfaces, `inputSchema = schema` which may be undefined).

Map entry: `{ fn: exec, schema: inputSchema, plugin, capability }` — the `fn`/`schema`/`plugin` keys
are retained so existing readers are untouched.

## The three projections

All three converge on one method:

```
invoke(name, args, { surface, print, warn, ask }) → Result
```

`invoke` validates `args` against `inputSchema` **once** (skipped when absent), gates the surface, and
calls `exec(input, ctx)`, wrapping the return in `ok(...)`.

- **Programmatic** — `invoke(name, args, { surface: 'programmatic' })`. The base projection.
- **CLI generator** (`sumo/cli`) — `commander` is the single CLI front door. A registered `'cli'`
  capability gets its subcommand for free: `buildCapabilityCommand` maps the catalog's input JSON
  Schema onto commander's option model (`number`/`integer` → `argParser(Number)`, `enum` →
  `.choices()`, required-without-default → mandatory, `default` seeded), so commander owns flag
  parsing, coercion, `--help`, and usage errors. The parsed flags become the args bag (built strictly
  from declared properties), dispatched via `invoke(…, { surface: 'cli' })` and rendered by the shared
  `renderResult`. Built-in infra verbs are registered commander commands delegating to their existing
  handlers; **the runtime boots lazily** — only when the invoked token is not an infra verb — so
  db-only verbs (`list`/`events`/`tail`) never trigger plugin activation. `--json`/`--config` are
  accepted before or after the subcommand. `sumo commands` is the catalog listing of reachable
  `'cli'`-surfaced capabilities (a programmatic/mcp-only or built-in-shadowed name is absent +
  diagnosed via `SUMO_CLI_NAME_SHADOWED`). A capability with no `inputSchema` takes no CLI flags
  (declare one to expose flags). Uses `commander`.
- **MCP generator** (`sumo/mcp`, launched by `sumo mcp` over stdio) — a low-level SDK `Server` whose
  `ListTools` projects the `'mcp'`-surfaced catalog entries to tools (`inputSchema` straight from the
  catalog; absent → open object; `outputSchema`/`annotations` passed through) and whose `CallTool`
  routes to `invoke(…, { surface: 'mcp' })`. A `Result` maps to tool `content` (text) + `isError`;
  a plain-object value also becomes `structuredContent`. `ctx.ask` returns `SUMO_NO_INTERACTION`
  (non-interactive surface). Uses `@modelcontextprotocol/sdk`.

## The surface model

`surfaces` declares where a capability appears. The generators **filter by surface first** — a
`['programmatic']`-only capability is absent from CLI help and from MCP `ListTools`. `invoke` also
**gates** as defence-in-depth: a direct `invoke(name, …, { surface })` for an undeclared surface
returns `fail('SUMO_SURFACE_UNSUPPORTED', …)`. Filtering is discovery; gating is enforcement.

## Diagnostics (stable `SUMO_*` codes; never thrown for operational failure, §3b)

| Code | Meaning |
|------|---------|
| `SUMO_NO_COMMAND` | `invoke(name)` for a capability that was never registered |
| `SUMO_COMMAND_INPUT_INVALID` | `args` failed the capability's `inputSchema` |
| `SUMO_SURFACE_UNSUPPORTED` | invoked on a surface the capability does not declare |
| `SUMO_NO_INTERACTION` | `ctx.ask(...)` on a non-interactive surface (MCP/headless) |

## Non-goals (explicit, reasoned boundaries — not gaps)

- **No streaming capabilities.** Capabilities are unary request→response. Live following (`tail`-style)
  is a *subscription/feed*, already first-class via `on(event, fn)` (plugins) and `db.subscribe`
  (daemon clients; `01-storage-and-eventing.md`). Forcing it through the capability layer would mean a
  never-returning MCP `CallTool` streaming progress notifications, which is unsound across MCP clients
  (progress is optional/monotonic status reporting; cancellation is client-dependent; Tasks are
  experimental). If a real need appears, revisit behind negotiated MCP Tasks — and document the why.
- **Infra verbs are not migrated.** `list`/`events`/`tail`/`daemon`/`doctor`/`forward`/`install`/
  `uninstall` remain bespoke CLI handlers this build; this build generates surfaces for **plugin**
  capabilities. `daemon`/`doctor` additionally cannot cleanly become capabilities (bootstrapping
  circularity: they report the liveness/health of the very runtime a capability would require), and
  `forward` is a raw native-hook **machine** protocol (stdin bytes → stdout bytes + fail-open/closed),
  not a human/agent capability. Making `list`/`events` reachable over MCP is a clean follow-up (it
  needs a lighter catalog/invoke path so read-only db scans don't pay full plugin activation).
