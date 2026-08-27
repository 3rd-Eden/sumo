# `journeys/` — persona journeys as model-based tests

First-class artifacts that sit between a spec and a test. Each `*.journey.md` is a **Melusine** journey
(YAML frontmatter + a mermaid flowchart) describing a real persona path through Sumo. **The graph IS the
test:** Melusine runs the graph, and `melusine.catalog.mjs` binds each node to one Sumo capability
invocation. Process nodes drive, decision/outcome nodes score against real state. A node whose
capability is not yet registered degrades to a Melusine `todo` gap rather than silently passing.

This is the journey → capability → test loop. As capabilities land, nodes flip from `todo` gaps to live
assertions; `journeys/spawn-with-model.journey.md` already runs end-to-end and PASSES (see below).

## Run

```bash
pnpm journeys
node journeys/melusine-cli.mjs validate journeys/spawn-with-model.journey.md --catalog journeys/melusine.catalog.mjs
node journeys/melusine-cli.mjs test journeys/spawn-with-model.journey.md --catalog journeys/melusine.catalog.mjs
```

`pnpm journeys` loops over the 1.0-fast journey set and invokes Melusine's own `test` command against
the shared `melusine.catalog.mjs`. It skips `p3-opportunist.journey.md` while the live repair-agent
fixture runner is gated, and skips `spawn-with-model.journey.md` because that long live harness path is
covered by `packages/journeys/test/spawn-with-model.live.test.mjs`. If an executed live journey hits a
real live prerequisite such as auth, quota, or backend availability, the runner reports the native
`SUMO_*` code and treats that journey as skipped. Individual journeys validate or execute through
`journeys/melusine-cli.mjs`, a small shim that delegates to Melusine's CLI `main()` without owning graph
execution.

Live by default (CONVENTIONS §5). A missing **real prerequisite** (the daemon won't start, a journey is
malformed) fails loudly with a non-zero exit. A missing **capability** is a Melusine `todo` gap —
reported, never a silent pass. The `.journey.md` files are executed by Melusine; executable proof lives
under `packages/journeys/test/`:
`spawn-with-model.live.test.mjs` (Journey 1, live `claude`),
`codex-whole-trail.live.test.mjs` (the server-kind whole trail, live `codex`), and
`drive-verbs.live.test.mjs` (cross-process cancel/send/end/resume, live `codex`) — each skips with
reason when its real binary is absent.

## The honest boundary

Melusine asserts only **structure** (capability exists, the call is schema-valid, a scorer's state-query
passes). Three things are human-authored in each journey, never invented:

1. **setup/trigger fixtures** — real captured content (§3f), referenced from frontmatter (e.g. P3's
   `trigger:` points at a captured dismissive-reasoning transcript);
2. **branch conditions** — every decision/outcome node names a real capability or documented
   state-query, never prose;
3. **non-assertion of semantic quality** — "was the fix correct" / "is the code good" is out of
   mechanical scope and is never faked green.

## Authoring convention

- Reusable building blocks live in **`melusine.catalog.mjs`**, keyed by capability name and built with
  Melusine's own `task()` / `scorer()` entries. Add a line there when a journey needs a new capability.
- A node selects a block with Melusine's native **`use:`** (`listFindings: { use: opportunist-findings }`);
  every other frontmatter key on the node is the capability input.
- Task outputs that later nodes need must be named with Melusine's native **`as:`** and referenced
  explicitly, e.g. `session: session`, `resumeFrom: native`, or `turn: sentTurn`.
- Mermaid shapes: `["…"]` process → task, `{"…"}` decision → scorer (branches labelled `yes`/`no`),
  `(["…"])` terminal. Name the start node `start`; every other terminal is an
  outcome scorer and must `use` a state-query capability (an unregistered one resolves to a `todo` gap).

The catalog may contain small Sumo-specific input mapping, but it must not own graph traversal, global
runtime lifecycle, or implicit state threading.

## Coverage map

These journeys map product capabilities to live assertions. A missing capability remains a visible
`todo` until its public surface lands:

| Journey node(s) | Capability | Status |
|---|---|---|
| `session-spawn` with a `model` | **** (model selection) + **** (session-control surface) | ✅ runs live |
| `session-is-running` / `session-await-ended` / live handle | **** (daemon-resident control) | ✅ runs live |
| `session-transcript-correlated` / `session-completed` (Claude whole-trail) | **** (whole-trail e2e test) | ✅ runs live |
| `session-events-correlated` / driven end (Codex whole-trail) | **** (server-kind whole-trail) | ✅ runs live |
| `session-cancel` / `session-send` / `session-end` / `session-resume` | **** (cross-process drive) + **** | ✅ runs live |
| `opportunist-findings` / `opportunist-resolve` | **** (opportunist plugin ledger commands) | ✅ plugin-tested |
| P3 auto-fix loop end-to-end (observe → record → spawn → resolve) | **** (live repair-agent fixture runner) | skipped by `pnpm journeys` |
| `work.detect` / `work.claim` / `work.run` / `work.review` / `work.release` | **** (claim → work → review → release) | ✅ runs live |

Each `todo` flips to a live assertion when its capability lands on the programmatic surface. Session
capabilities and Opportunist's command surface are live; the full child-agent repair journey remains a
live fixture runner.

## Journeys

- **`spawn-with-model.journey.md`** — JOURNEY 1 (**runs live, PASS**): spawn claude with a chosen model
  → `session-is-running` (running + model recorded) → `session-await-ended` → `session-transcript-correlated`
  (native id + path correlated, and transcript re-ingest collapses onto the live stream) → `session-completed`.
  Live gate: `packages/journeys/test/spawn-with-model.live.test.mjs`; skipped by default `pnpm journeys`.
- **`codex-whole-trail.journey.md`** — the SERVER-kind companion to Journey 1 (**runs live, PASS**): spawn
  codex with a chosen model → `session-is-running` (running + model recorded) → `session-events-correlated`
  (the live stream is Sumo-keyed, with the native id preserved in `ext`) → drive `session-end` (Codex never
  self-exits) → `session-await-ended` → `session-completed`. Transcript+dedupe is intentionally NOT asserted
  here (Codex's `transcriptPath` is filled by the acquirer on tail-discovery, not at spawn). Live gate:
  `packages/journeys/test/codex-whole-trail.live.test.mjs`.
- **`drive-verbs.journey.md`** — cross-process control on the server kind (**runs live, PASS**, ): spawn
  codex → `session-await-active-turn` → `session-cancel` (real `turn/interrupt`, thread survives) →
  `session-await-turn-completed` → confirm still running → `session-send` a follow-up turn on the
  surviving thread → `session-await-turn-completed` (so a resumable rollout persists) →
  `session-end` → `session-native-id` (thread the native id) → `session-resume` a NEW session from it →
  confirm it runs → end. Live gate: `packages/journeys/test/drive-verbs.live.test.mjs`.
- **`p3-opportunist.journey.md`** — P3 opportunist repair loop: observe dismissive reasoning →
  `opportunist.finding-detected` → spawn a repair agent → await its end → resolve through child result
  evidence or `opportunist-resolve`. `pnpm journeys` skips the full loop until the live fixture runner
  lands; plugin behavior is covered by `plugins/opportunist/test/opportunist.test.mjs`.
- **`claim-work-review-release.journey.md`** — the claim → run → review → release workflow vision. It is
  backed by first-party `work.*` capabilities and runs through Melusine as part of the 1.0 journey set.
