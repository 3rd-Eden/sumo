# `sumo/orchestrator` — the event reactor and the sole actor

The one layer permitted to **act**. Every other package is a sensor (emits normalized events) and/or an
effector (exposes `session.key`/`send`/`end`/`capture`/`respondApproval`, `work.claim`/`release`) — none
decides on its own observations. The orchestrator is the only thing that both sees the whole event
stream and holds the authority to pull a trigger. It is a **privileged consumer of the plugin runtime**
([`sumo/plugin`](../plugin)), not a second event loop: it reacts through the runtime's `on()`, guards
every spawn, turns silence into events, and acts only through the effectors the producing layers expose.

Imported as `sumo/orchestrator`. It follows the shared package rules: return aligned `Result`
objects for operational failures, surface facts as events, and keep workflow policy in plugins.

> **Core owns mechanism; plugins own policy.** This package is the reactor, the lifecycle
> (spawn/health/reap), the silence→event timers, the universal process-management handlers, the
> runaway guards, and the `modify` decision-override mechanism. The *why/when* — roles, review
> strategy, what-to-do-on-a-stall beyond the universal defaults — lives in plugins that react to the
> same stream and override decisions via `sumo.modify`. The issue-to-agent-to-review flow is a
> demonstration, so it lives in the test that proves it
> ([`spike/orchestrator-loop.test.mjs`](../../spike/orchestrator-loop.test.mjs)), not here.

---

## Principle: react to events, never to doc state

The `ses:<id>` document is an eventually-consistent registry — its `state` is patched fire-and-forget
and lags the session lifecycle. The **event log is ordered truth.** Every orchestrator decision keys off
the `session.*` / `work.*` / `messenger.*` **events** in the stream, never a doc read. (The runtime's
`SumoEvent.session()` resolver is not wired, so the orchestrator is also the only holder of live
`Session` handles — see the registry below.)

---

## How it sits on the runtime

Construct the orchestrator **before** `runtime.start()` (so its handlers + seams are in place when the
runtime subscribes), then start the runtime:

```js
import { plugin } from 'sumo/plugin';
import { Orchestrator } from 'sumo/orchestrator';

const runtime = plugin({ cwd, db, config: { harness: { 'claude-code': { bin } } } });
const orch = new Orchestrator({ runtime, db });   // wires seams + universal handlers, arms the sweep
await runtime.start();                            // built-in harnesses auto-register
```

It consumes three small, policy-free seams the runtime exposes (the runtime only forwards; it learns
nothing about orchestrator vocabulary):

| Seam (`runtime.*`, pre-`start`) | Why |
|---|---|
| `extendFacade(verb, handler, { staged })` | contributes the `modify`/`guard`/`surface`/`health` verbs onto every plugin's `sumo`. `staged: true` registrars (`modify`/`guard`) roll back with a failed plugin activation, like `on`; actions (`surface`/`health`) run immediately. |
| `wrapRun(hook)` | wraps the built-in `sumo.run` so **every** spawn is guard-checked, registered in the live-session registry, and timer-armed. |
| `on('*', fn)` (engine all-events observer) | the orchestrator tracks activity across all session-scoped events (including `session.raw:*` passthrough) without enumerating types. |

No second queue/watermark/subscription: reactions go through `runtime.sumo.on(...)`; silence events are
`db.append`ed and loop back through the runtime's own pump.

---

## The plugin-facing primitive API

`Orchestrator` exposes the kernel, and the same verbs reach plugins through the facade seam:

| Primitive | On the facade | What it does |
|---|---|---|
| `run(prompt, opts?)` | `sumo.run` (wrapped) | guarded spawn → `Result<Session>` |
| `on(type, fn, opts?)` | `sumo.on` (alias) | react to the stream |
| `modify(name, base, e)` | `sumo.modify(name, fn, opts?)` (register) | resolve / override a named decision (partial-object waterfall) |
| `guard(name, g)` | `sumo.guard(name, g)` (register) | register a runaway guard |
| `health(session)` | `sumo.health(session)` | the four-signal liveness answer |
| `surface(e, reason?)` | `sumo.surface(e)` | route a condition to a human/messenger |

`modify` on the orchestrator is the **resolver** (`name, base, e`); `sumo.modify(name, fn, opts?)` on the
facade is the **registrar** — same word, two roles.

### `modify` — the decision-override waterfall

Core holds a safe default decision at a named point; plugins override:

```js
// core handler (mechanism)
orch.on('session.approval-requested', async (e) => {
  let d = await orch.modify('approval', { action: 'surface' }, e);  // default = ask a human
  // … respondApproval(allow/deny) or surface(e)
});

// project plugin (policy)
export default function approvalPolicy(sumo) {
  sumo.modify('approval', (decision, e) => {
    if (/rm\s+-rf/.test(e.payload?.command ?? '')) return { action: 'deny', reason: 'destructive' };
    // return nothing → pass through unchanged
  });
}
```

Overrides run in priority order. Each gets a **fresh shallow copy** of the current decision (a
no-return is a true no-op — it cannot mutate the thread). An object return is shallow-merged over the
current decision (flat-decision contract; nested objects replace wholesale). A throwing **or slow**
override (past a 5 s cap) is skipped **fail-open** with a diagnostic, so a prompt/approval is never left
unanswered.

### Universal handlers (core defaults; act only via effectors on owned handles)

| Event | Reaction |
|---|---|
| `session.prompt-detected` | known-safe banner → `session.key('Enter')`; else default `surface`, `modify('prompt', …)`, then act/surface |
| `session.approval-requested` | default `surface`; `modify('approval', …)`; then `respondApproval` or `surface` |
| `session.stalled` | if `nudge`, `session.send(nudge)` + arm shutdown timer; continued silence → `capture()` (death snapshot) → `end({force})` (reap) |
| `session.rapid-death` | advance the per-`spawnKey` circuit-breaker (don't respawn into a loop) |
| `session.ended` / `session.dead` | finalize the registry entry; a normal end resets the breaker |
| `messenger.proof-of-life-request` | resolve the owned session, run `health`, and **surface the verdict** |

If a handler needs a `Session` for an id that is not in the registry (i.e. the orchestrator did not
spawn it), it **surfaces** rather than acting blind.

### Silence → events (the timers' one job)

A periodic sweep over the live-session registry converts the *absence* of events into events the harness
can't see (a session that is alive but producing nothing): `session.idle` after the short `idle`
threshold, then `session.stalled` after the long `stall` threshold — **once per silence epoch** (activity
reopens a fresh epoch and cancels any pending reap). Emitted via `db.append` with an explicit per-epoch
`dedupe` (`orch:<type>:<sessionId>:<epoch>`); the orchestrator then reacts to them like any event.

### `health` — the four-signal answer

`health(session)` → `Result<{ alive, signals }>` for an **owned** session: **process** (no terminal
event seen and not past `done()`), **state** (`running`/`done`/`ended`, registry-tracked — not
doc-polled), **activity** (an event within the `stall` window), **output** (a non-empty `capture()`;
`capture()` returns a `Result` and is called at most once — an unsupported capability degrades to
`unknown`, never counted as death). A session the orchestrator does not own → `SUMO_SESSION_UNKNOWN`.

### Guards (runaway protection; counts/timers, workflow-independent)

Enforced inside the `wrapRun` hook before any spawn. The limit check **and** the reservation are
synchronous (no `await` between them), so two concurrent `run`s can't both pass at the cap.

| Guard | Trip code |
|---|---|
| global + per-plugin **rate limit** (sliding window) | `SUMO_RATE_LIMITED` |
| **maxRounds** — spawns per `spawnKey` loop budget | `SUMO_MAX_ROUNDS` |
| **maxAgents** — concurrent live sessions | `SUMO_MAX_AGENTS` |
| **rapid-death circuit-breaker** — consecutive rapid deaths per `spawnKey` | `SUMO_BREAKER_OPEN` |
| custom `guard(name, g)` (sync; falsy/`{ok:false}` blocks) | `SUMO_GUARD_TRIPPED` |

`spawnKey` defaults to the calling plugin id; a workflow passes `run(prompt, { spawnKey })` to scope
maxRounds + the breaker per work item. A failed spawn rolls the reservation back; a session end releases
its slot.

---

## Lifecycle — the live-session registry

`wrapRun` is the only writer of the registry (the sole source of `Session` handles). On a successful
spawn the orchestrator records `{ session, spawnKey, startedAt, lastActivityAt, epoch }` and arms timers.
Disarm happens on the terminal **event** OR `session.done()` resolution, **whichever first** — because
the harness appends terminal events fire-and-forget and `done()` can resolve before they land, disarming
only on the event would leak a timer or emit a stale stall. A short grace window keeps the entry alive
after `done()` so a still-in-flight terminal event can update the breaker, then finalizes.

---

## Codes

Fallible primitives return the shared `Result` (`{ ok: true, value? } | { ok: false, code, reason }`).

| Code | Meaning |
|---|---|
| `SUMO_RATE_LIMITED` / `SUMO_MAX_ROUNDS` / `SUMO_MAX_AGENTS` / `SUMO_BREAKER_OPEN` | a guard tripped (no spawn) |
| `SUMO_GUARD_TRIPPED` / `SUMO_GUARD_INVALID` / `SUMO_GUARD_ASYNC` | custom guard blocked / not a function / returned a Promise (guards are sync) |
| `SUMO_MODIFY_INVALID` | `sumo.modify(name, notAFunction)` — ignored with a diagnostic |
| `SUMO_SESSION_UNKNOWN` | `health` of a session the orchestrator does not own |
| `SUMO_CAP_UNSUPPORTED` | an effector the session's `can` doesn't support |

The orchestrator emits **`orchestrator.surfaced`** (`source: 'orchestrator'`) when it routes a condition
to a human/messenger; a relay plugin observes it so core stays medium-agnostic.

---

## Development

```bash
pnpm test                                              # full repo suite (node:test)
node --test packages/orchestrator/test/*.test.mjs      # this package only (use a file glob)
```

Tests exercise the **real** `sumo/db` daemon + the real plugin runtime. Silence/guard/health mechanism
is driven with a minimal in-test harness *driver* (`test/_driver.mjs`), used because real Claude can't
be made to sit alive-but-silent on demand. The live harness-agnostic proof (Claude pipe + Codex server
through one orchestrator) is the spike integration test.

### Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | `Orchestrator` class: seam wiring, universal handlers, registry lifecycle, the primitive API, `surface`, `stop`. |
| `decisions.mjs` | the `modify` waterfall: register + resolve (shallow merge, fail-open, per-override timeout). |
| `guards.mjs` | rate / maxRounds / maxAgents / rapid-death breaker; synchronous reserve + rollback/release. |
| `timers.mjs` | the silence sweep: `idle`/`stalled` per epoch, activity `bump`, dedupe. |
| `health.mjs` | the four-signal liveness answer. |
| `schema.mjs` | `Result` helpers + `CAP_UNSUPPORTED`, and the orchestrator config zod for timeouts and guards. |

---

## Behavioral Boundaries

- **Proof-of-life is answer-only.** On `messenger.proof-of-life-request` the orchestrator runs
  `health` and surfaces the verdict. Publishing that verdict back to a medium belongs to the
  messenger layer, because only a messenger owns the medium-specific effector.
- **The rapid-death breaker can miss a count if a terminal event arrives more than 5 seconds after
  `done()`** because the registry entry is finalized after the grace window. This is theoretical for
  single-instance spawn-only work where event delivery is normally sub-millisecond.
- **`session.raw:*` counts as activity but is not otherwise interpreted.** Passthrough events keep a
  session "alive" for the timers; richer handling is a workflow concern.
