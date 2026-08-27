# 06 — Config (`sumo.yml`)

## Resolution chain

Global → parent projects → nearest → env → flags. Later layers override earlier ones.

```
~/.sumo/sumo.yml                      # global defaults
  → <parent>/sumo.yml ... (top-most first)   # discovered project configs walking DOWN to cwd
  → ./sumo.yml (nearest, walking UP from cwd)
  → environment (SUMO_*)
  → runtime flags (--config, individual overrides)
```

**Stop rule (walking up from cwd, collecting `sumo.yml` files):** halt at whichever comes first —
(a) a config declaring `root: true` (ESLint-style marker), (b) the git repository root, or (c)
`$HOME`. `root: true` stops the upward search at that file.

```
# resolution (pseudocode)
function resolveConfig(cwd, flags, env):
 chain = [ load("~/.sumo/sumo.yml") ] # global first
 files =
 dir = flags.config ? dirname(flags.config): cwd
 node = flags.config ?? findNearest(dir, "sumo.yml")
 while node:
 files.unshift(node) # top-most ends first
 cfg = parse(node)
 if cfg.root == true: break
 if dir == gitRoot(dir) or dir == HOME: break
 dir = parent(dir); node = findNearest(dir, "sumo.yml")
 merged = chain[0]
 for f in files: merged = mergeLayer(merged, parse(f)) # fill-missing merge, see below
 merged = applyEnv(merged, env) # env overrides config
 merged = applyFlags(merged, flags) # flags override env
 validate(merged) # collect ALL errors → diagnostics (not throw-first)
 return merged
```

## Merge semantics (aligned with the rest of the system — §3b)

Config layering is a merge problem, and per the anti-drift principle it uses the **same
replace-vs-merge discipline** as partial-object merge payloads and orchestrator `modify` — not a config-specific
invention — with **one sanctioned config-only exception** (the `~name` disable):

- **Objects deep-merge** (later layer's keys override/extend earlier).
- **Scalars replace** (later wins).
- **Arrays merge** (concatenate + dedupe) by default.
- **`use:` plugin array** supports explicit disable via a `~name` prefix: `use: ["~noisy-plugin"]`
 removes a plugin a parent layer enabled. This is the one config-specific merge rule (partial-object merge payloads
 have no equivalent need); it is documented as a deliberate divergence, mirroring ESLint's
 extends/override ergonomics.

## Schema (current)

```yaml
# ~/.sumo/sumo.yml  (or ./sumo.yml)
root: false                      # set true to stop parent search here

use:                             # plugin list (loops sumo.use in order); ~name disables inherited
  - github-messenger
  - handoff
  - knowledge-base
  - "~noisy-plugin"

storage:
  path: .sumo/db                 # LevelDB directory (NOT a sqlite file) — 01
  retention:                     # TTL sweeper defaults — 01/16
    rawDays: 14
    eventDays: 90

daemon:                          # 02
  socket: ~/.sumo/sumo.sock
  idleShutdown: 30m              # auto-stop when idle
  scope: project                 # see "Daemon resolution context" below

harness:
 default: claude-code
 fallback: [codex, cursor] # first available candidate after default

orchestrator: # orchestrator vocabulary — 10
 timeouts: { stall: 10m, shutdown: 1m, rapidDeath: 15s, nudge: true }
 guards: { maxRounds: 7 }

plugins: # per-plugin config blocks, each validated by that plugin's schema
 github-messenger:
 repo: owner/name
 label: sumo:ready
 dependency:
 sources: [team, npm, github, web]
 mode: nudge # nudge | block (block degrades per-harness — see 08)
```

## Per-plugin config validation (the ownership decision)

**A plugin declares its zod schema; Sumo validates the slice BEFORE calling the plugin.** This is the
chosen fork (over "the plugin validates `options` itself in its body"), because it is consistent with
the pre-run introspection we already accept (`myPlugin.sumo.plugins`, ) and it makes a bad config
a **diagnostic surfaced in `sumo doctor`**, not a mid-run throw.

```js
export default function github(sumo, options) { /* options is already validated */ }

// declared on the plugin — Sumo reads + validates the `plugins.github-messenger` slice against this
github.sumo = {
  config: z.object({
    repo:  z.string(),
    label: z.string().default('sumo:ready')
  })
};
```

`options` passed to the plugin **is the validated config slice** (`plugins.<name>` merged with any
`use(plugin, opts)` inline options). The plugin never re-validates or re-resolves. Missing/invalid
config for an enabled plugin → the plugin is marked `unavailable` with a reason in diagnostics, never
a crash.

## Validation = a user-facing collection point (§3b aligned #4)

Validation **collects all errors** across all layers and plugin slices and reports them together as
`SumoDiagnostic[]` (with the layer/file that introduced each), rather than throwing on the first. This
is the "user-facing collection point gathers errors" rule from CONVENTIONS §3b — the same model used
for plugin load. Each diagnostic carries `source: { file, plugin?, line? }` so the user sees exactly
which layer caused which error.

## Harness selection config

`harness.default` is the preferred coding-agent harness for `sumo.run(...)`. `harness.fallback` is an
ordered list of additional harness ids to try when the preferred candidate is unavailable or a spawn
fails with a fallback-eligible harness error. The runtime probes candidates through each adapter's
`available()` method before spawning; `available` and `unknown` are usable, while `unavailable`
records its reason and moves to the next candidate.

The provider-level candidate order is:

1. explicit `opts.harness`, when supplied
2. `harness.default`
3. `harness.fallback`
4. built-in preference: `claude-code`, `codex`, `cursor`
5. any remaining registered harnesses

Duplicate ids are ignored after their first occurrence. If `opts.resume` is set, Sumo does not
cross-fallback because native resume ids are harness-specific.

## Environment

| Var | Effect |
|---|---|
| `SUMO_CONFIG` | sets the config path (useful for long-running daemon / CI) |
| `SUMO_DB` | overrides `storage.path` |
| `SUMO_HOME` | overrides `~/.sumo` (global config + socket + global db) |

Env overrides config files; flags override env.

## Daemon resolution context (a context the original glossed)

The daemon (`02`) is long-running and serves **many CLI invocations from different cwds**, so "which
config applies" is **per-operation, not resolved once.** A CLI call carries its originating `cwd`; the
daemon resolves (and caches) config for that cwd-context per request. `daemon.scope` controls this:

- **`scope: project`** (recommended default) — config (and the daemon's view) is resolved per project
  root; one daemon may serve multiple projects, each with its own resolved config.
- **`scope: global`** — a single resolved config for everything (simpler, less flexible).

This connects to the open one-daemon-vs-per-project question (`02`); `scope` is how config expresses it.

## Compatibility considerations

-   `--config <path>`: compose with parents (recommended — still includes parent +
  global unless the file declares `root: true`) vs isolated/complete (reproducible CI). Recommend
  compose, with `root: true` as the explicit opt-out.
-   `daemon.scope` default (`project` recommended) and its relationship to the
  one-global-daemon-vs-per-project decision in `02`.
-   Whether `orchestrator`/`daemon`/`storage` blocks are core-schema-validated while
  `plugins.*` are plugin-validated, or all slices go through the same declared-schema path. Recommend
  core blocks have a core schema; plugin blocks use the plugin's declared schema.
