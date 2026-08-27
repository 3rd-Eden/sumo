# 10 — Orchestrator

> Read with `CONVENTIONS.md` §3a/§3b/§3c (shared patterns, aligned contracts, surface-don't-act),
> `01`/`02` (event log + daemon), `04`/`05` (sessions + harness), `11` (messenger coordination).

## What the orchestrator is

**The orchestrator is the event reactor and the sole actor.** Every other package *surfaces*
(emits normalized events) and *exposes effectors* (`session.key`/`send`/`respondApproval`,
`work.reply`); none of them act on their own observations (§3c). The orchestrator subscribes to the
one unified event stream, interprets conditions, and drives the effectors — bounded by the runaway
guards. It is the only thing that both sees everything and is allowed to act.

Because everything is evented (this is *why* we hammered on the plugin/adapter eventing discipline),
the orchestrator makes correct decisions **regardless of which adapters/plugins are loaded** — it
reasons over a uniform event contract, not over adapter-specific APIs.

**It lives in the daemon** (`02`) — the long-running process that already owns the event log — so
orchestration state survives across CLI invocations and it tails the log it is adjacent to.

## Event-driven, not poll-driven

Sumo's adapters push:
the messenger emits `work` the moment work appears, the session emits as the agent runs, the daemon
emits on every write. So the orchestrator **reacts to events**; it does not poll sources.

**Timers do exactly one job: convert the *absence* of events into an event.** Stall, rapid-death,
and idle-reap are all "nothing happened within N" conditions. A timer turns silence into a
`session.stalled` / `session.rapid-death` / `session.idle` event on the log; the orchestrator then
reacts to that like any other event. There is no parallel polling decision path — everything funnels
through the one stream.

## Three uniform event sources

All arrive as the same normalized `evt:<seq>` shape (`01`), so reaction logic is written once:

| Source | Examples |
|---|---|
| **Messenger** | `work` appeared, claim changed, proof-of-life request, review posted |
| **Session** | started, output, `prompt-detected`, idle, stalled, approval-requested, died |
| **Database/lifecycle** | a plugin wrote, TTL swept, a derived event emitted by another handler |

## Two responsibility halves (both event reactions)

### A. Session/workflow lifecycle
spawn on demand → monitor health → reap when idle → guards. The mechanism layer plugins build
workflows on.

### B. Process management ("babysitting" real CLIs)
React to conditions that surface *during* a session's life by driving effectors. This is the part a
human operator would otherwise do by hand. Same pattern every time: **a condition surfaces as an
event; the orchestrator interprets and acts via an exposed effector.** The adapter never had to know
about the condition — it just surfaced output and offered the effector.

## Worked example 1 — the Claude upgrade banner (the canonical sole-actor case)

```
1. SENSOR:  Claude's `pipe` transport emits raw output containing an upgrade banner.
            The session adapter does NOT recognize or dismiss it — it surfaces it:
              evt { type:'session.output', sessionId, text:'A new version of Claude…[Enter] to continue' }
            and (via prompt-pattern detection, 04) a normalized:
              evt { type:'session.prompt-detected', sessionId, prompt:'upgrade-banner', expects:'enter' }

2. ACTOR:   the orchestrator, subscribed to the stream, sees session.prompt-detected.
            It matches a known condition ('upgrade-banner') and acts via the exposed effector:
              await session.key('Enter')      // the orchestrator pulls the trigger, not the adapter

3. RESULT:  banner dismissed; the agent continues. No adapter contained banner logic.
```

The session adapter is a **sensor + effector**: it surfaced the banner and exposed `key()`. The
orchestrator is the **actor**: it decided and drove the effector. A new banner variant, or a wholly
new condition, is handled by adding orchestrator/plugin reaction — **zero adapter changes**.

```js
// inside the orchestrator — universal condition handlers (core)
orchestrator.on('session.prompt-detected', async (e, { session }) => {
 const action = orchestrator.resolve(e); // see partial-object override below
 if (action.dismiss) await session.key(action.key ?? 'Enter');
});
```

## Worked example 2 — interactive approval, with project override (partial-object modify)

A condition with no single right answer: an agent hits "Allow tool `Bash(rm …)`? (y/n)". Core has a
safe default (surface to human); a project may override (auto-deny `rm -rf`, auto-allow under /tmp).
**Override is a partial-object `modify`** — a plugin returns a partial that the orchestrator merges over
its default decision (replace-vs-merge semantics from `the partial-object merge contract`, async, per `03`).

```js
// core default (in the orchestrator)
orchestrator.on('session.approval-requested', async (e, { session }) => {
  let decision = { action: 'surface' };            // safe default: ask a human
  decision = await orchestrator.modify('approval', decision, e);   // plugins may override
  if (decision.action === 'allow')   return session.respondApproval({ ok: true });
  if (decision.action === 'deny')    return session.respondApproval({ ok: false, reason: decision.reason });
  /* surface */                      return orchestrator.surface(e);   // route to human/messenger
});
```

```js
// a project plugin overrides the decision — does NOT touch the session/adapter
export default function approvalPolicy(sumo) {
 sumo.modify('approval', (decision, e) => {
 if (rm\s+-rf/.test(e.payload.tool?.command)) return { action: 'deny', reason: 'destructive' };
 if (e.payload.tool?.cwd?.startsWith('/tmp')) return { action: 'allow' };
 // return nothing → decision passes through unchanged (partial-object merge waterfall)
 });
}
```

The plugin expresses *policy* by overriding the orchestrator's *decision*; it never reaches into the
session to send keys. All acting still flows through the orchestrator's effector authority (§3c).
This is how "business logic doesn't live in the packages" works in practice: the `session` package
stays pure mechanism; the orchestrator owns the decision; the project tweaks it via `modify`.

## Worked example 3 — rate-limit back-off (process management)

```
SENSOR:  session emits evt { type:'session.output', text:'…rate limit reached, retry in 60s' }
         → normalized by the harness adapter to evt { type:'session.rate-limited', retryMs:60000 }
ACTOR:   orchestrator reacts:
           - pause dispatch to this session, set a timer for retryMs
           - optionally: orchestrator.modify('rate-limit', { action:'wait' }, e)
             → a plugin could override to { action:'switch-tier', model:'fast' }
           - when the timer fires (silence→event), resume
```

Again: the adapter only surfaced the message and exposed the effector (`send`/model-switch). The
orchestrator decided. A plugin can change the policy via `modify` without adapter changes.

## Worked example 4 — stall → nudge → snapshot → reap (lifecycle + silence-as-event)

```
TIMER:   no event from sessionId in `stall` window (10m) → emit evt { type:'session.stalled' }
ACTOR:   orchestrator.on('session.stalled'): if nudge enabled → session.send(nudge); start shutdown timer
         no recovery within `shutdown` (1m) → snapshot() (capture terminal before destroying)
                                            → session.end({ force:true })   (reap)
GUARD:   if this session rapid-died (<15s after spawn) → trip circuit-breaker, do NOT respawn into a loop
```

`health(session)` is the four-signal check (process alive / not dormant / activity within stall /
captured output) the orchestrator runs when it needs a liveness verdict. Death snapshots are written
before every `end`/`kill` (the reference implementation's pattern) and TTL-swept with the session.

## Worked example 5 — issue → agent → cross-model review (workflow as a plugin)

Roles (action/reviewer/planner) and cross-model review are **NOT core** — they are a workflow plugin
reacting to the same stream and calling orchestrator primitives. This is `issueFlow` from `11`,
now precise:

```js
export default function issueFlow(sumo, options) {
  sumo.on('work', async (work) => {
    const claim = await work.claim();                 // adapter-owned coordination (11)
    if (!claim.ok) return;
    const worker = await sumo.run(work.prompt);        // orchestrator spawns + guards
    await worker.done();                               // resolves on session.ended event
    const handoff = await sumo.handoff(worker);        // handoff plugin
    const reviewer = await sumo.run(handoff, { harness: options.reviewer ?? 'codex' }); // DIFFERENT model
    const verdict = await reviewer.result();
    await work.review({ passed: /APPROVE/i.test(verdict), verdict });
    await work.release({ outcome: 'reviewed' });
  });
}
```

The orchestrator enforces `maxRounds` (review loop cap) and `maxAgents` (per-role concurrency) as
guards around this; the *policy* (review with a different model, what "approve" means) is the plugin.

## Distributed coordination — proof-of-life as a liveness answer

Proof-of-life is **not** a core orchestrator concern; it is the orchestrator *answering a liveness
query on behalf of a distributed adapter*. Gated behind the adapter's `can.distributed` (`11`).

```
1. A distributed messenger adapter (e.g. GitHub, can.distributed=true) detects a foreign claim and,
   per its OWN four-gate logic + medium, surfaces:  evt { type:'messenger.proof-of-life-request', agent }
2. The orchestrator that OWNS that agent reacts: runs health(agent) → a Result.
3. It hands the verdict back to the adapter, which publishes the response in its medium (comment +
   marker) and decides eviction via its four-gate sequence + release markers.
```

The orchestrator supplies the **answer** (health — only it can check if a session/pane is alive);
the adapter supplies the **question, the medium, and the eviction decision**. The orchestrator never
knows it's GitHub; the adapter never knows how to check a pane. Single-instance local work
(`can.distributed=false`, the common case) does zero proof-of-life — the machinery is dormant
until a distributed adapter activates it. the reference implementation's request/response protocol, four-gate eviction, and
release markers are the **reference implementation that lives in a distributed messenger adapter**,
not in core.

## The plugin-facing primitive API (small, this is the kernel line)

```js
/**
 * @typedef {Object} Orchestrator
 * @property {(prompt:string, opts?:object) => Promise<Session>} run // spawn a guarded session
 * @property {(sel:EventSelector, fn:Function, opts?:Order) => void} on // react to the stream (alias of sumo.on)
 * @property {(name:string, base:any, e:object) => Promise<any>} modify // partial-object override of a decision
 * @property {(name:string, g:Guardrail) => void} guard // budgets/caps/circuit-breakers
 * @property {(session:Session) => Promise<Result>} health // four-signal liveness answer
 * @property {(e:object) => Promise<void>} surface // route a condition to a human/messenger
 */
```

- **Core owns:** the reactor, the lifecycle (spawn/health/reap), the silence→event timers, universal
  process-management handlers (banners, stalls, rapid-death), and the guards (`maxAgents`,
  `maxRounds`, `rapidDeath` circuit-breaker, `stall`/`shutdown` timeouts).
- **Plugins own (policy, via `on` + `modify`):** which conditions get which responses beyond the
  universal defaults, roles, review strategy, project approval policy — all by reacting to events and
  overriding decisions, never by acting on a session directly.

## Config (orchestrator vocabulary, verified defaults)

```yaml
harness:
  default: claude-code
  fallback: [codex, cursor] # ordered failover candidates for sumo.run and orchestrator retries

orchestrator:
  timeouts:
    stall: 10m        # no event from a session → session.stalled
    shutdown: 1m      # graceful before forced end
    rapidDeath: 15s   # startup crash window → circuit-breaker
    nudge: true       # tier-1 stall nudge before reap
  guards:
    maxRounds: 7      # review/iterate loop cap before escalation
    # per-role caps declared by the workflow plugin, enforced by the orchestrator
```

Harness failover uses the resolved runtime `harness.fallback` list. For a normal `sumo.run(...)`
without an explicit harness, provider selection handles the whole availability-aware chain. For an
explicit harness request, the orchestrator may retry provider-compatible fallback ids from the same
configured list after fallback-eligible failures (`SUMO_NO_HARNESS`, `SUMO_BACKEND_UNAVAILABLE`,
budget/rate/overload, or generic spawn failure). Resume attempts never cross-fallback because native
resume ids are harness-specific.

## Compatibility considerations

-   How much process-management is universal-core vs plugin policy (banners: core;
  approvals: core-default + plugin-override; rate-limits: ?). Recommend: surface/observe always core;
  acting defaults core only where universally safe (banner dismiss, stall reap), everything
  judgemental defaults to `surface` and is overridable.
-   Whether `modify` decision points are a fixed core set or plugin-declarable.
-   Reactor concurrency model inside the daemon (single async loop vs worker pool).
