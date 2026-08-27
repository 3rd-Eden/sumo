# 13 — Installation & Lifecycle

> Installation reconciles desired state idempotently, preserves foreign configuration, and reports
> every change. Detached daemon startup relies on the LevelDB single-owner lock to resolve races.
>
> Read with `02` (daemon), `03` (`install` verb, plugin deps), `05`/`12` (harness config + `sumo
> forward` hook entry), `06` (config scope), `16` (consent for mutations).

## Why this layer exists

Every other spec assumes *installed state*: a running daemon, harness hook configs pointing at `sumo
forward`, MCP servers registered, plugins resolved and their deps present. This layer is how a user
gets from `npm install` to that state — and how it stays correct as harness configs drift, plugins are
added, and Sumo updates. It was the missing layer.

## Core principle: idempotent reconciliation, not file generation

Installation is **"make reality match desired state," safe to run repeatedly** — never blind file
generation. Desired state = (config `use:` list + enabled plugins' `install` declarations + which
harnesses are present). Actual state = (current hook configs, registered MCP servers, running daemon,
installed plugin deps). Install diffs the two and applies the difference. Re-running converges; it does
not duplicate.

Four sub-principles:

1. **Preserve foreign config; merge, never overwrite.** Writing into `.cursor/hooks.json` / Claude
   settings / Codex `config.toml` or `.codex/hooks.json` / Copilot `.github/hooks/*.json` /
   `.mcp.json` means **merging Sumo's entries in and leaving everyone else's alone.** See "Merging is
   a hard requirement" below.
2. **Consent-gated** (§16, ). Install mutates files Sumo doesn't own and starts processes, so it
   shows what it will change and gets approval; `--skip-install` does dry registration only.
3. **Reversible.** Every Sumo-written entry is **marked** (sentinel/namespaced key), so `sumo
   uninstall` removes exactly Sumo's additions and leaves the user's intact.
4. **Drift-aware.** `sumo doctor` reports install-state drift (daemon down, hook config no longer
   points at `sumo forward`, missing MCP server/dep, harness config-format changed); `sumo install`
   reconciles it. Install is never one-shot — it is reconcilable state.

## The DX target: one command, idempotent

```bash
npx sumo init           # or: sumo install   — reconcile this project up to desired state
```

Resolves config, detects which harnesses are present, merges their hook configs to forward to `sumo
forward`, registers required MCP servers (`.mcp.json` etc.), installs plugin deps, ensures the daemon,
and **reports what it changed**. Re-running is safe. This is capture corpus's `install all` ergonomic scaled
to the full ecosystem.

```bash
sumo install --global   # write user-level configs (~/.claude, ~/.cursor) — applies everywhere
sumo install            # project scope — writes ./.cursor/hooks.json, ./.sumo/ — committable
sumo uninstall [--global]  # reconcile DOWN: remove only Sumo's marked entries
sumo doctor             # report install + runtime drift; NO mutation
```

## Scope: both global and per-project (mirrors config)

Install operates at the scope you target, and the two compose exactly like the config resolution chain
(`06`) and `daemon.scope` ():

- **`--global`** — writes user-level harness configs (`~/.claude/`, `~/.cursor/`), Sumo hooks apply to
  every project. For "I always want my guardrails."
- **project (default)** — writes the repo's `.cursor/hooks.json`, `.sumo/`, etc. Committable,
  team-shareable. For "this project's workflow."
- **Compose:** a project install adds onto whatever global install established; the harness sees both
  sets of hooks (their native config merge handles the union). No conflict — additive at both scopes.

## Daemon lifecycle: auto-start detached, no system service

The daemon is **not** a system service and has no install step. It is auto-started on demand:

```
On ANY CLI invocation (sumo <cmd>, an MCP call, or a hook firing `sumo forward`):
  1. probe the unix socket (~/.sumo/sumo.sock)
  2. if a daemon answers → use it
  3. if not → spawn a detached child_process daemon, then connect:
       spawn('sumo', ['daemon'], { detached:true, stdio:'ignore' }).unref()
  4. the daemon idles out after `daemon.idleShutdown` (30m, /06) when unused
```

Because **everything enters through the CLI** — humans, MCP, and hooks (via `sumo forward`, §12) — this
one check covers all entry paths. There is no "did you start the daemon" step.

**The auto-start race is resolved by the LevelDB lock (no extra coordination needed).** If two CLI
calls start near-simultaneously and both try to spawn a daemon, only one acquires LevelDB's
single-process lock (verified, ); the loser's spawn fails fast and falls back to connecting to the
winner. The lock we already depend on *is* the "exactly one daemon" guarantee.

**Cold-start constraint:** a hook firing `sumo forward` when no daemon is running pays spawn + DB-open
+ plugin-load latency, inside the harness's blocking hook timeout (§12 budget). Mitigation: `sumo
install` (and `sumo init`) **warm the daemon** so the first *hook* is never the cold-starter under a
blocking timeout. The startup path must be fast regardless.   acceptable cold-start
budget vs. per-harness hook timeouts.

## Merging is a HARD requirement (not a fallback)

Hook configs are **arrays of hooks per event** — the attached real `.cursor/hooks.json` shows
`beforeShellExecution: [ {...}, {...}, {...} ]`; Claude settings hooks are arrays; Codex `[hooks]`,
Copilot `hooks.<event>[]`, and `.mcp.json` server lists are additive. So merging is just **append
Sumo's marked entry to the event's array**, and re-running **replaces Sumo's marked entry** rather than
duplicating. There is no native format that forces a destructive overwrite.

Therefore: **every harness adapter's config writer MUST merge additively** — append + mark Sumo's
entries, preserve all foreign entries (user's and other tools'), support clean removal of only Sumo's.
This is a **contract requirement tested by conformance (§4)**, not a best-effort. If an adapter cannot
merge a harness's config, that is a **bug in the adapter**, not a property to design a fallback around.
(A genuinely unmergeable future format would be a `can`-declared capability gap surfaced as a
diagnostic — never a silent destructive write.)

The per-harness config writer lives in the **harness adapter** (`05`) — it already owns native-format
knowledge (TOML/JSON/settings). Adding a harness does not touch the core install engine.

## Architecture: core engine + plugin requirements + adapter writers

Three pieces, by concern (§3d):

- **Core reconciliation engine** — computes desired vs actual state, orchestrates the diff/apply,
  handles consent, reporting, the daemon ensure, and `doctor` drift detection. Harness-agnostic.
- **Plugins contribute requirements** via the `install` verb (): the MCP servers and agent skills
  a plugin needs, plus plugin install-dependencies (`plugin.sumo.plugins`, , auto-installed
  `@latest` as devDependencies). The engine merges all enabled plugins' requirements into desired state.
- **Harness adapters own config writers** — merge/preserve/mark/remove for their native format. The
  engine calls them; it does not know TOML from JSON.

```
sumo install
  → resolve config (06) → desired = use[] + plugins' install reqs + present harnesses
  → for each harness present: adapter.config.reconcile(desired)   // merge hooks → `sumo forward`, MCP servers
  → install plugin deps (pnpm devDeps, consent) + plugin install() reqs (MCP/skills, consent)
  → ensure daemon (auto-start if down) + warm
  → report every change made
```

## Acceptance / conformance

1. `sumo install` on a project with an existing hand-written `.cursor/hooks.json` **preserves** the
   user's hooks and **adds** Sumo's, marked; re-running does not duplicate.
2. `sumo uninstall` removes exactly Sumo's marked entries, leaving the user's intact.
3. Two near-simultaneous CLI calls with no daemon running result in **exactly one** daemon (LevelDB
   lock); the loser connects.
4. A hook firing `sumo forward` with no daemon auto-starts one and still responds within the harness
   hook timeout (warm path); `sumo install` pre-warms so the first hook isn't the cold-starter.
5. `--global` and project installs compose; the harness sees both hook sets, no duplication.
6. `sumo doctor` reports drift (daemon down / hook config edited away / missing MCP server / missing
   plugin dep) without mutating, and `sumo install` reconciles it.
7. Each harness adapter's config writer passes the additive-merge conformance test (append, preserve
   foreign, mark, clean-remove).

## Compatibility considerations

-   Acceptable daemon cold-start budget vs per-harness hook timeouts; whether `install`
  pre-warming is sufficient or a lightweight always-warm option is wanted.
-   Whether project installs auto-commit the `.cursor/hooks.json`/`.sumo/` changes or
  leave staging to the user (recommend leave to user; just write the files).
-   Global+project hook *de-duplication* if the same Sumo hook is installed at both
  scopes (recommend the marked entry makes this detectable; project wins, skip the global duplicate).
