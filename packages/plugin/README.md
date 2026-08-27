# `sumo/plugin` — the plugin runtime

The layer a plugin author actually touches. A plugin is a **function**, `function plugin(sumo,
options)`, default-exported, that calls a small set of **flat verbs**. This package wires those verbs
to the two layers beneath it — [`sumo/config`](../config) (the ordered `use` list + validated
per-plugin options) and [`sumo/db`](../db) (the event log + scoped KV) — builds the objects handed
*into* a plugin, and runs the single-pass activation lifecycle.

Imported as `sumo/plugin`. The runtime validates plugin inputs with zod, returns aligned `Result`
objects for expected operational failures, and surfaces facts instead of acting outside the plugin's
declared verbs.

For a start-to-finish plugin authoring guide with examples, see
[docs/plugins.md](../../docs/plugins.md).

> **Scope.** The runtime + every plugin-facing seam. It does **not** implement harnesses,
> messengers, the CLI/MCP projection, installation, or the orchestrator. Where a verb needs a missing
> layer it returns an honest capability-failure `Result` (`SUMO_NO_*`) surfaced as a diagnostic.

---

## The plugin model

A plugin is a function, registered with chainable `use`. No manifest, no permissions, no
execution-strategy choice — the engine picks the mode from the verb.

```js
export default function testGate(sumo, options) {
  const store = sumo.store('test-gate');                  // scoped, TTL-aware kv

  sumo.on('test:done', (e) => {                           // observe — parallel, return ignored
    store.set(e.payload.repo, { passed: e.payload.passed });
  });

  sumo.before('finish', async (e) => {                    // steer — waterfall, return-to-merge / {deny}
    const t = await store.get(e.payload.repo);
    if (!t?.passed) return { deny: 'run tests first' };
  });

  sumo.command('test-status', ({ repo }) => store.get(repo)); // contributes a verb (CLI + MCP)

  sumo.on('work', async (work) => {                       // an adapter is never named
    const prompt = `Work item: ${work.title ?? work.id}\n\n${work.body ?? ''}`;
    const s = await sumo.run(prompt);                     // → Result<Session>
    if (!s.ok) return;                                    // e.g. SUMO_NO_HARNESS
    await s.value.done();
    await work.reply('✅ done');                          // reply bound onto the work by its messenger
  });

  sumo.destroy(() => { /* cleanup */ });
}

// optional static marker, introspected before activation
testGate.sumo = {
  name: 'sumo-plugin-test-gate',                          // canonical id (else the fn name / use entry)
  plugins: ['sumo-plugin-knowledge'],                     // declared plugin dependencies
  config: z.object({ /* ... */ })                         // validates the plugins.<id> slice
};
```

```js
import { plugin } from 'sumo/plugin';

const rt = plugin({ cwd: process.cwd() });
rt.sumo.use(testGate, { testCommand: 'npm test' }).use(reviewer).use('sumo-plugin-knowledge');
await rt.start();
// … later …
await rt.stop();
```

---

## The verb surface (`sumo`)

| Verb | Mode | Return |
|---|---|---|
| `on(event, fn, opts?)` | observe — **parallel** fan-out, errors isolated | ignored |
| `before(action, fn, opts?)` | steer — **async waterfall**, runs in the agent's blocking path | return-to-merge / `{deny}` |
| `command(name, fn, schema?)` **or** `command(create({…}))` | contribute a capability (CLI + MCP + programmatic, all GENERATED from one definition; unique name). The thin form is sugar for a minimal capability. | result to the caller |
| `skill(name, fn, meta?)` | register a Sumo-level skill intent; provisioning is handled by install surfaces | — |
| `run(prompt, opts?)` | spawn a session | `Promise<Result<Session>>` |
| `store(ns)` | scoped kv (`kv:<plugin>:<ns>:<key>`) | `Store` |
| `emit(type, payload?, opts?)` | append a plugin-sourced event to the shared event log | assigned `seq` |
| `install(declaration)` | declare consent-gated provisioning (run by the install layer) | `Result` |
| `use(plugin, opts?)` | compose / pack | chainable `sumo` |
| `destroy(fn)` | teardown (reverse order on shutdown) | — |
| `harness(name, impl)` / `messenger(name, impl)` | provider-side registration (rare) | — |

`opts` for `on`/`before` is `{ priority?, timeout?, safety? }` (validated by `HandlerOpts`).
**Ordering = a single `priority` integer, default 100, higher runs first.** No before/after graph.

### `on` vs `before` (two real execution modes)

- **`on` → fan-out.** Every observer for an event runs concurrently; **return values are ignored**;
  one throwing/timing-out observer does not stop the others (its error goes to the host sink). Default
  timeout `OBSERVE_TIMEOUT_MS` (20 s).
- **`before` → waterfall.** Handlers run in priority order, threading the event. The return contract
  copies `the partial-object merge contract`' modify pattern, made async:
  - return **nothing** → pass through unchanged;
  - return **`{ event: {…} }`** → shallow-merged onto the event for the next handler;
  - return **`{ deny: reason }`** → **bail** (sticky — no later handler can un-deny). The adapter layer
    translates `deny` into the harness-native block; the author never names a harness.
  - A higher-priority handler may take a **`previous()`** thunk (2nd arg) to wrap the downstream chain
    (opt-in "meta-plugin" decoration). It is single-shot and **deterministic**: once called, the
    engine always awaits the downstream subtree and applies the wrapper's own return on top (deny
    stays sticky) — there is no timing-dependent behavior. Default timeout `STEER_TIMEOUT_MS` (5 s).
  - **Timeout/throw policy:** fail-**open** (skip, continue) by default; **fail-closed** (`{deny}`) when
    the handler is registered `{ safety: true }`. The engine races the promise against a
    local timeout and clears the timer on both fulfillment and rejection, but it cannot stop a
    handler's async work, so steering handlers **must not perform late side effects** — the engine
    clones the event per handler so an in-place mutation can never corrupt the thread.

---

## Objects handed *into* a plugin (03a)

The producing layer binds methods onto each object, scoped to its origin, so the consumer never names
an adapter (this is "github never surfaces", mechanically).

| Object | Where | Bound surface |
|---|---|---|
| `SumoEvent` | `on(type, fn)` | `seq`/`ts`/`type`/`sessionId`/`payload`/`ext` + `emit(type, payload)`, `raw()`, `session()` |
| `SteerEvent` | `before(action, fn)` | `action`/`payload`/`ext`/`can` + `raw()`; acts via the return value |
| `InvocationCtx` | `command` 2nd arg | `surface`, `print`, `warn`, `ask` (→ `Result`; `SUMO_NO_INTERACTION` off-CLI) |
| `Store` | `store(ns)` | `get`, `set`, `del`, `scan`, `merge` |
| `Session` | `await sumo.run()` | built by the harness layer (`hctx.session`) — typed contract here |
| `Work` | `on('work', fn)` | built by a messenger (`mctx.work`) with `reply`/`claim`/… already bound |

`SumoEvent.emit` supplies the schema-required `dedupe` itself
(`plugin:<id>:from:<parentSeq>:<type>:<stableHash(payload)>`), so re-emitting an identical derived
event collapses idempotently instead of looping.

---

## Lifecycle

`start()` is a single ordered pass (the DB opens **before** activation so `store()` works inside a
plugin body):

```
1. resolveConfig(cwd, flags, env)            → ordered `use` list + raw plugins.<id> slices
2. import plugin modules                     → parse each `.sumo`; canonicalize a string plugin's id
                                               from its declared name
3. openDb()                                  → connect to the daemon
4. activate via a dependency fixpoint        → deps before dependents; missing/unavailable → skip with
                                               a diagnostic; a cycle is broken + reported
5. subscribe `on` handlers from the watermark → ready
```

**Each plugin activates transactionally.** Its registry mutations (`on`/`before`/`command`/`skill`/
`install`/`destroy`/`harness`/`messenger`/`use`) are staged and committed only if its function — which
is **awaited**, so `async` bodies and late `use(child)` complete — returns; a throw rolls them all
back with a `SUMO_PLUGIN_ACTIVATE` diagnostic, so a failed plugin leaves nothing half-registered.
Plugin **options** are the `plugins.<id>` slice **merged with** inline `use(plugin, opts)` (inline
wins), and the merged result is validated as a whole against the plugin's `.sumo.config`. Plugin ids
beginning with the reserved `__sumo_` prefix are rejected — that namespace is the runtime's own KV.

Event delivery uses the runtime's own **FIFO queue + contiguous-seq watermark**
(`kv:<runtime>:sub:watermark`): each event's fan-out is awaited to completion before the watermark
advances, so a crash never drops an observer's work and the watermark never skips. Delivery is
at-least-once; re-delivery is safe because derived `emit` is dedupe-idempotent.

`stop()` sets a stopping flag, **unsubscribes / drains in-flight work**, runs `destroy` callbacks in
**reverse** activation order, then closes the DB (only if the runtime opened it).

### Dependencies — two distinct notions

- **Capability presence** is undeclared and surfaces at call time as a runtime diagnostic
  (`SUMO_NO_HARNESS`, `SUMO_NO_MESSENGER`). A plugin just calls the verb.
- **Plugin install-dependencies** are declared on the plugin (`plugin.sumo.plugins`) and drive
  activation order. A missing/unavailable declared dep marks the dependent **unavailable** with a
  `SUMO_PLUGIN_DEP_MISSING` diagnostic and skips it. The runtime does **not** install dependencies;
  the installation layer owns provisioning.

---

## Usage of the runtime API

```js
const rt = plugin({ cwd, flags, env, db /* optional: inject a SumoDb */ });
rt.sumo.use(myPlugin);
await rt.start();

await rt.steer('finish', { payload: { repo: 'owner/x' } }); // → { event } | { deny }
await rt.invoke('test-status', { repo: 'owner/x' });        // → Result (drives a capability)
rt.capabilities();                                          // machine-readable catalog (CLI/MCP generators read this)
rt.diagnostics();                                           // collected DiagnosticSchema-compatible objects
await rt.stop();
```

| `plugin(opts)` | Notes |
|---|---|
| `cwd` / `flags` / `env` | passed straight to `resolveConfig`. |
| `db` | optional `SumoDb` to reuse (tests inject an isolated daemon); otherwise the runtime opens + owns one and closes it on `stop()`. |

Plugin **options** are the `plugins.<id>` config slice shallow-merged with any inline
`use(plugin, opts)` (inline wins), then the merged result is validated against the plugin's own
`.sumo.config`. A config block for a programmatically-registered plugin is honored (not silently
ignored), and inline opts cannot bypass schema validation.

---

## Codes

Fallible verbs return the shared `Result` (`{ ok: true, value? } | { ok: false, code, reason }`);
capability-absence is surfaced as a diagnostic, never thrown. Programmer errors (bad `use` arg,
duplicate name) throw.

| Code | Meaning |
|---|---|
| `SUMO_NO_HARNESS` | `run(...)` with no registered or available harness after probing the candidate chain |
| `SUMO_NO_MESSENGER` | a messenger-bound op with no messenger |
| `SUMO_NO_INTERACTION` | `ctx.ask(...)` on a non-interactive surface (MCP/headless) |
| `SUMO_CAP_UNSUPPORTED` | an adapter declares (via `can`) it cannot do the op |
| `SUMO_PLUGIN_DEP_MISSING` | a declared `plugin.sumo.plugins` dep is absent/unavailable |
| `SUMO_PLUGIN_CONFIG_INVALID` | a plugin's (merged) config failed its declared schema |
| `SUMO_PLUGIN_DECL_INVALID` | a plugin's static `plugin.sumo` marker is malformed |
| `SUMO_PLUGIN_CYCLE` | a cycle among declared deps (broken + reported) |
| `SUMO_PLUGIN_LOAD` / `SUMO_PLUGIN_ACTIVATE` | a module plugin failed to import / threw during activation (rolled back) |
| `SUMO_NO_COMMAND` / `SUMO_COMMAND_INPUT_INVALID` | `invoke` of an unknown command / bad command args |
| `SUMO_QUEUE_BACKPRESSURE` | (warning) the delivery queue exceeded its soft high-water mark |

---

## Development

```bash
pnpm install                                       # deps
pnpm test                                          # full repo suite (node:test)
node --test packages/plugin/test/*.test.mjs        # this package only
```

> Use a file glob. `node --test packages/plugin/` does **not** work — it treats the directory as a
> module. Tests exercise the **real** `sumo/db` daemon, `sumo/config`, built-in harness adapters, and
> reference messenger implementations. In-test fake harness/messenger registrations are forbidden.

### Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | Public surface: `plugin` + the builders/contracts. |
| `runtime.mjs` | The lifecycle, the per-plugin `sumo` facade, event dispatch, `steer`/`invoke`. |
| `engine.mjs` | The owned priority-sorted registry: parallel `fanout` + the merge/deny/`previous` `steer` waterfall, local timeouts. |
| `use.mjs` | Registration, canonical-id resolution, cwd-anchored module import, stable topo sort. |
| `store.mjs` | `store(ns)` over `kv:<plugin>:<ns>:<key>` with percent-encoded segments (no delimiter bleed). |
| `received.mjs` | Builders for `SumoEvent` / `SteerEvent` / `InvocationCtx`. |
| `providers.mjs` | `harness`/`messenger` registration + `hctx`/`mctx`; the `run` seam. |
| `schema.mjs` | `Result` helper re-exports, `SUMO_*` codes, `PluginDecl`/`HandlerOpts` zod + JSDoc typedefs. |

---

## Key decisions (locked)

- **The engine is owned, not a dependency.** `priority-ordered handler engine`'s single replace-waterfall `exec` fits
  neither mode, and reaching into its private `mapping` to bypass `exec` is fragile — so the registry
  (priority sort, context bind, per-handler timeout) lives in `engine.mjs`. The timeout race is local
  because the previous package helper left timers alive after fast rejections.
- **`the partial-object merge contract` is a pattern, not a dependency.** It is a React UI slot library; its
  modify/override + `previous`-chaining *shape* is copied into the steer waterfall, nothing imported.
- **`skill` is registration-only.** Provisioning belongs to the install layer; this runtime records
  skill intent and does not execute skills directly. There is no runtime `skill.run`.
- **`run`/`harness`/`messenger` are honest seams.** With no backend they return `SUMO_NO_*` or record
  install intent. They do not fake a backend.
- **Canonical plugin id** = explicit `{name}` / `plugin.sumo.name` > the module-specifier string >
  `fn.name`. It keys config slices, options, the store segment, and dedupe.

## Boundaries

- **Plugin stores are scoped key-value stores.** The daemon's full-text index is global, so the
  plugin store exposes scoped KV operations and does not fake scoped FTS.
- **`Session` / `Work` construction lives elsewhere.** The shapes are the typed contract here; the
  harness and messenger layers build them via `hctx.session` / `mctx.work`. Tests must use built-in
  adapters, captured real fixtures, live prerequisites, or shippable reference adapters.
- **Install intents are recorded, not executed.** `install(declaration)` and `skill(...)` accumulate intents
  for the installation layer; this package performs no provisioning.
- **`run` returns `Result<Session>`**, while the 03a example reads a bare `Session`. The seam is
  `Result`-typed so the no-capability path is honest; the post-unwrap ergonomic is the caller's.
- **Provider verbs use the factory form** (`harness(name, impl)` + `mctx`/`hctx`). Provider authors
  should follow the factory form documented here for this package.
