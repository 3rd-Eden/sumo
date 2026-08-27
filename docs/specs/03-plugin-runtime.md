# 03 — Plugin Runtime

> The runtime uses a Map registry, priority-ordered handlers, bounded async execution, scoped verbs,
> partial-object merge semantics, and a single-pass lifecycle. Read with `CONVENTIONS.md` (`.mjs`,
> zod, adapters).

## Design principle: simple surface, solid core

Ease of use is the product. A plugin author writes a **function**, registers it with **`use`**, and
calls a **small set of flat verbs**. They never see a registry, an execution strategy, an ordering
graph, or an adapter name. Underneath, the solid parts (async waterfall, priority sort, timeout
cancellation, return-to-merge) do the work invisibly.

## The plugin: a function

A plugin is `function plugin(sumo, options) { ... }`, default-exported from an `.mjs` module. It is
called with the host (`sumo`) and its resolved options, and it calls flat verbs. There is **no**
manifest, **no** `{hooks, actions}` object, **no** `dependencies` array, **no** permissions, **no**
execution-strategy choice.

```js
// sumo-plugin-test-gate/index.mjs
export default function testGate(sumo, options) {
  const store = sumo.store('test-gate');                 // scoped, TTL-aware kv

  sumo.on('test:done', (e) => {                          // observe — parallel, return ignored
    store.set(e.repo, { passed: e.passed });
  });

  sumo.before('finish', async (e) => {                   // steer — waterfall, return-to-merge/deny
    const t = await store.get(e.repo);
    if (!t?.passed) return { deny: 'run tests first' };
  });

  sumo.command('test-status', ({ repo }) => store.get(repo));  // contributes a verb (CLI + MCP)

  sumo.on('work', async (work) => {                      // 'github' never appears
    const s = await sumo.run(work.prompt);
    await s.done();
    await work.reply('✅ done');                          // reply bound onto the work object
  });

  sumo.destroy(() => { /* cleanup */ });
}
```

```js
import sumo from 'sumo';
sumo.use(testGate, { testCommand: 'npm test' })          // chainable; fn / {name,fn} / module string
   .use(reviewer)
   .use('sumo-plugin-knowledge');
```

## `use` — registration (from `the registration contract`)

```js
sumo.use(fn)                       // function: called as fn(sumo, options); name = fn.name
sumo.use({ name, fn })             // object: name from .name
sumo.use('sumo-plugin-x')          // string: import()'d, then used
sumo.use(fn, { key: 'value' })     // options passed to the plugin
sumo.use(a).use(b).use(c)          // chainable, returns sumo
```

Rules (from source): name is `fn.name`/`.name`; **missing name throws**; **duplicate name throws**
("select a unique name"); a `use:` array in `sumo.yml` loops `use` in order. A plugin that calls
`sumo.use(child)` is a **pack** — no special concept, just nesting.

## The verb set (deliberately small)

| Verb | Kind | Execution | Return contract |
|---|---|---|---|
| `on(event, fn, opts?)` | observe | parallel, fed by daemon event stream | ignored |
| `before(action, fn, opts?)` | steer / transform | async waterfall, runs in agent's blocking path | return-to-merge / `{deny}` bail |
| `command(name, fn, schema?)` | contribute | invoked on demand | result returned to caller |
| `skill(name, fn, meta?)` | contribute | invoked by an agent/workflow as a skill | `Result` |
| `run(prompt, opts?)` | act | spawns a session | resolves to a `Session` handle |
| `store(ns)` | resource | — | returns scoped kv |
| `install(spec)` | setup | run at activation (consent-gated) | `Result` |
| `use(plugin, opts?)` | compose | — | chainable |
| `destroy(fn)` | lifecycle | run on shutdown | — |
| `harness(name, impl)` / `messenger(name, impl)` | **provider-side, rare** | — | not in the workflow-author path |

`opts` is `{ priority?: number }` only (see Ordering). The provider-side verbs (`harness`,
`messenger`) are how adapters are contributed; a *workflow* author never calls them and never names
an adapter — see "github never surfaces."

### `skill(name, fn, meta?)` — register a skill intent
Registers a skill: a named, agent- or workflow-invokable unit of work (vs. `command`, which is a
human/MCP-facing entry point). A workflow can execute it (`await sumo.skill.run('adversarial-review',
ctx)`), and it can be exposed to harnesses that support skills. Returns a `Result`. Skills are how
"a full workflow end-to-end — brainstorm → plan → adversarial review → subagent handoff → persona
review" is composed: each stage is a skill the orchestrating plugin runs in sequence. (Distinct from
*harness-native* skill files, which are artifacts `install` may set up and `agent-artifacts` ingests;
`skill()` records a Sumo-level skill intent for the install layer.)

### `install(spec)` — declare setup the plugin requires
Registers setup actions run at activation, **consent-gated** (subject to `--skip-install` and the
mutation-confirmation rules in `12`/security). A plugin uses this to declare the **MCP servers** and
**agent skills** it needs present for it to function:
```js
sumo.install({
  mcp:    [{ name: 'techcom', url: 'https://…/mcp' }],   // MCP servers to register
  skills: [{ name: 'review-standards', source: './skills/review.md' }],  // agent skills to install
});
```
`install` runs idempotently (safe to re-run; discovers what exists, creates only what's missing — the
the reference implementation `start` pattern). Failures surface as diagnostics; nothing auto-runs without consent. This is
distinct from plugin install-dependencies (which pull in *other Sumo plugins* — see Dependencies §2);
`install` provisions *non-plugin* resources (MCP servers, skills) the plugin needs.

### `on(event, fn)` — observe
Registers an observer. All observers for an event fire in priority order; **return values are
ignored**; observers **cannot block**. Fed by the daemon event stream (`01-storage-and-eventing.md`),
so `on('work', …)`, `on('test:done', …)`, `on('session.ended', …)` all see normalized events.

### `before(action, fn)` — steer / transform
Registers into a named action waterfall (`finish`, `tool`, `prompt`, …). Runs as an **async
waterfall** (priority-ordered handler engine `exec`): each handler receives the (possibly already-modified) event. The
**return contract is the merge contract.s, made async**:

- return **nothing** → pass through unchanged;
- return **`{ event: {…} }`** → the object is **shallow-merged** into the event for the next handler
  (you do not merge yourself);
- return **`{ deny: reason }`** → **bail** the chain immediately (supply `next(err, done)` semantics),
  and Sumo translates `deny` into the harness's native block in the adapter layer
  (`12-hooks-and-steering.md`). The author writes `{ deny }`; the harness ("claude"/"codex"/…) is
  never named here.

`before` only takes effect on a session where steering was verified (`04-session-control.md`); on a
session that can't steer, a `deny` degrades to a warning + diagnostic, never a silent no-op.

### `command(name, fn, schema?)` — contribute a verb
Registers a command. The same `name`/`fn` (+ optional zod input `schema`) is surfaced as a **CLI
subcommand and an MCP tool** (`16-interfaces-cli-mcp.md`). Unique-named; duplicate throws.

### `run(prompt, opts?)` — spawn a session
Returns a `Session` handle (`04-session-control.md`). Backend kind/harness are chosen by the session
layer; the author passes `opts.harness` only to force one.

### `store(ns)` — scoped kv
Returns a kv handle bound to the plugin's LevelDB sublevel (`kv:<ns>`), TTL-aware
(`01-storage-and-eventing.md`). A plugin cannot address another plugin's namespace.

### `destroy(fn)` — teardown (from `scoped provider`)
Registers a cleanup function run on shutdown.

## Engine: priority-ordered, two modes

Sumo owns a small `priority-ordered handler engine`-shaped engine (`add` / `remove`, priority-sorted handlers, local timeout
race with guaranteed timer cleanup) with **exactly two exec modes**, selected by the verb — the author never chooses:

- **`on` → fan-out mode:** run all subscribers (priority order), ignore returns, errors routed to the
  host error handler. Observers are independent; one failing does not stop others.
- **`before` → waterfall mode:** `result = await timeoutRace(runner(result, ...args), timeout) || result`,
  with fill-missing merge applied to a returned object and a `{deny}` sentinel that short-circuits.

```js
// internal wiring (illustrative .mjs)
const reg = registry({ context: sumo, onError: sumo.onError });
// on(event, fn, {priority})    -> reg.add('observe', event, fn, { priority })
// before(action, fn, {priority})-> reg.add('steer',  action, fn, { priority })
// emit:   await reg.exec('observe', event, payload)   // returns ignored
// steer:  const out = await reg.steer(action, event)  // partial-object merge / {deny} bail
```

## Ordering: one priority number (from `priority-ordered handler engine`)

Ordering is a single optional `priority` integer. **Default 100. Higher runs first.** That is the
entire ordering model — no `before`/`after`/`first`/`last`, no topological sort, no cycle errors.
This is the simple, sufficient answer already proven in `priority-ordered handler engine`.

```js
sumo.before('finish', fn);                 // default priority 100
sumo.before('finish', fn, { priority: 200 }); // runs earlier
```

> Rejected (too complex, per direction): the dependency graph.s `{first,last,before,after}` topo-sort. If a hard
> "must run after plugin X" need is ever demonstrated in practice, it can be added as an additive
> opt-in, but the system leads with — and defaults to — priority.

## Dependencies: two DIFFERENT things, do not conflate them

There are two distinct notions of "dependency" and the system treats them separately. Conflating them
was an earlier error in this spec; this section corrects it.

### 1. Capability presence — a runtime diagnostic (no declaration)

Whether a *capability* is available at call time (is a harness registered? did a messenger produce
this work?) is NOT declared. A plugin simply calls verbs; if a needed capability isn't present —
`sumo.run(...)` with no usable harness, `work.reply(...)` with no messenger — it gets a clear error
(`SUMO_NO_HARNESS`, `SUMO_NO_MESSENGER`) surfaced in `sumo doctor`. `sumo.run(...)` is availability
aware: it probes the configured/default/fallback harness candidates through adapter `available()`
before spawning and returns `SUMO_NO_HARNESS` when none is usable. This keeps the simple function
surface and needs no registration-time graph. This preserves clear missing-dependency diagnostics without a
machinery.)

### 2. Plugin install-dependencies — DECLARED in the plugin interface

A plugin that *requires other Sumo plugins to be installed* MUST declare them, because the system
cannot infer this any other way. **Critical distinction:** `dependencies` in a plugin's own
`package.json` are npm libraries its *code imports* — they are NOT the Sumo plugins it needs the
system to install. The system has no way to tell, from package.json, which deps are "libs I use" vs
"Sumo plugins that must also be active." Therefore the requirement is declared **on the plugin
itself**, in a field distinct from package.json:

```js
export default function myPlugin(sumo, options) { /* ... */ }

// declared on the plugin — read by the system BEFORE running it (no side effects to introspect)
myPlugin.sumo = {
  // Sumo plugins this one requires to be INSTALLED + active. Distinct from package.json deps.
  plugins: [
    'sumo-plugin-github',                       // resolves to @latest
    { name: 'sumo-plugin-knowledge', version: '^2' }
  ]
};
```

What the system does with it:

- **Reads `myPlugin.sumo.plugins` before activation** (a static-ish field on the function, so it can
  be introspected without running the plugin — the one bit of pre-run introspection we keep).
- **Auto-installs missing declared plugins**, defaulting to `@latest`, added to the project's
  `devDependencies` (subject to the consent / `--skip-install` rules in `12`/security; install is a
  mutation and is gated).
- **Activates them** so the dependent plugin's `use` runs after its declared plugins. Missing/failed
  installs surface in `sumo doctor` as `unavailable` with reason — never silent.
- This is **how a plugin is discoverable as a plugin** (vs. an arbitrary npm package): the
  `myPlugin.sumo` marker is what tells the system "this is a Sumo plugin, and here is what it needs."

### Packs are the natural expression of #2

A **pack** is a plugin that declares/registers other plugins — i.e. `myPlugin.sumo.plugins` plus
`sumo.use(child)` calls in its body. Same install + ordering + lifecycle rules as any plugin; no
separate "pack" concept. A pack is just a plugin whose job is to pull in and wire a set of others.

>   Install mechanism details: write to `package.json#devDependencies` + run the
> package manager (pnpm) vs a Sumo-managed plugin store under `~/.sumo`. Recommend devDependencies +
> pnpm so plugins are normal, auditable, version-pinned project deps. Consent rules per `12`.

## Timeouts

Every invocation is wrapped in the engine's local timeout race so a hung plugin is not awaited forever.
- **`before` (steering): default ~5s** — it runs in the agent's blocking path, so it must be short.
- **`on` / transforms: default 20s**.
Overridable per-fn (`fn.timeout`) or via host options. This is the runaway-protection primitive —
not budgets or permissions.

## "github" never surfaces

A workflow author never names an adapter. Two mechanisms enforce this:
1. **Work carries its own bound verbs.** A messenger produces normalized `work` objects with
   `work.reply` / `work.claim` / `work.done` already bound to their origin. `on('work', …)` consumes
   them; the GitHub-ness is sealed inside the object.
2. **Adapter contribution is a separate, rare path.** `sumo.harness(name, impl)` /
   `sumo.messenger(name, impl)` are provider-side verbs used by adapter packages, not by workflow
   plugins. Registering an adapter is authorship; consuming its output is the normal surface.

## Wrapping (from the merge contract.s `previous`)

If a plugin needs to *wrap* another's behavior for the same action (decorate, not replace), the
waterfall handler may receive a `previous` reference (the merge contract.s `previous` chain) to call the
underlying implementation. This is the "meta-plugin" capability without a new API — it is just a
higher-priority `before` handler that calls `previous`. Not in the default surface; available when
needed.

## Lifecycle: one ordered pass (the dependency graph.s *lesson*, simplified)

A defined boot moment exists, but it is a single pass, not the dependency graph.s four-phase waterfall:

```
1. resolve config (sumo.yml chain) → ordered `use:` list + per-plugin options
2. for each plugin in order: call use(plugin, options)   // populates registries via verbs
3. connect to the daemon; subscribe `on` handlers from the correct event watermark
4. ready
```

The daemon/orchestrator waits for step 4 before flowing events. `destroy` callbacks run on shutdown
in reverse order.

## Reference integration

The `testGate` plugin above is the reference. It exercises: `store` (scoped kv), `on` (observe from
the event stream), `before` (steer with `{deny}`), `command` (CLI+MCP verb), `run` + `Session`
(spawn), `work.reply` (adapter-neutral messaging), `destroy` (teardown) — the entire author surface,
with no adapter names, no manifest, no strategy choice, no ordering graph.

## The trade-off, stated plainly

Because plugins are **functions, not objects**, Sumo cannot introspect a plugin's hooks/deps before
running it — registration happens by *calling* it. Static plugin objects can be inspected first, but
objects. Sumo chooses the function surface anyway: it is the ease-of-use the simple modules are built
on; Sumo is a local single-engineer tool, not a registry doing capability negotiation, so pre-run
introspection buys little; and missing-capability-as-runtime-diagnostic covers the real failure case.
This is the one the dependency graph.strength consciously given up, and it is the right call for this project.

## Runtime defaults

- Steering handlers time out after 5 seconds; observers and transforms time out after 20 seconds.
- `previous` wrapping is an opt-in capability rather than part of the default author surface.
- Sumo owns its small handler registry directly and does not add a runtime engine dependency.
