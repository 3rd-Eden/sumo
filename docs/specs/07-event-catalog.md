# 07 — Normalized Event Catalog

## Why this exists

The orchestrator is an event reactor (`10`) and the KB compiles knowledge from "everything Sumo
knows" (`14`) — both reason over a *uniform* stream. That only works if there is a **defined, stable
set of event types** a plugin can rely on, rather than each adapter inventing ad-hoc strings. This
catalog is that vocabulary. It is the thing a plugin author consults to know what they can `on(...)`.

## Conventions

- **Dotted, namespaced `type`** — `<domain>.<event>` (`session.stalled`, `work.claimed`).
- **Normalized fields in `payload`; adapter-specific fields in `ext`** (`01`). A consumer reads
  `payload` for cross-adapter logic and `ext` only when it needs adapter specifics.
- **Every event carries the required `dedupe` key** (`01`/`05`) — source-preferred id else content
  hash — so duplicates across sources (live stream + transcript) collapse at the daemon.
- **Events are facts about what happened** (divergent from work items, which are things to do —
  CONVENTIONS §3b). Past tense where natural.
- **Derived events** (emitted by a plugin via `event.emit`, e.g. `test:done`, `kb.pattern-detected`)
  are first-class and use the same envelope; plugins may namespace their own (`<plugin>:...`).
- **Passthrough / un-normalizable events surface, never drop (CONVENTIONS §3e).** A native event with
  no normalized mapping still becomes an event: `type` = `session.raw:<native>` (or `<domain>.raw:...`),
  raw payload in `ext`, normalized fields empty. Plugins can `on('session.raw:<native>', …)` to react
  to a harness's idiosyncratic events. The adapter never decides an event is unimportant enough to
  drop — that is the orchestrator's/plugin's call (§3c). Only the TTL sweeper removes data, by age.

## Absent fields: declared via `can`, consumers tolerate absence

The four harnesses differ in *what data they produce at all*, not only in format. A normalized field
may be **absent** because the originating harness simply never emits it (e.g. token-usage on a harness
that doesn't report cost; a tool result on a harness whose transcript omits it). This is the
**missing-and-unrecoverable** case — distinct from missing-but-recoverable, which the daemon's
merge-on-dedupe completes from a richer second source (`02`).

Rules:
- **A normalized field is optional unless every targeted harness can produce it.** A consumer (KB,
  orchestrator) MUST tolerate absence — treat "not present" as "this harness doesn't report it," not
  as zero/error.
- **What a harness can report is declared in its `can`** (`05`), so absence is *predictable*, not
  surprising: `can.cost === false` means `payload.tokenUsage` will be absent for that harness.
- **No faking.** A parser never fabricates a value to fill a field its harness didn't produce (the
  "declare, don't fake" rule, §3c / §3b aligned #2). Absent stays absent.
- This is why enrichment (`02`) only ever *fills gaps from a real second source* and never invents
  data: if no source has the field, it stays absent, and the consumer handles that via `can`.

## Core catalog (the stable vocabulary)

### `session.*` — agent session lifecycle & activity (from the harness adapter / session layer)
| type | when | key payload |
|---|---|---|
| `session.started` | a spawned session is ready | sessionId, harness, cwd |
| `session.output` | raw output chunk surfaced | text |
| `session.message` | a normalized transcript message | role, text |
| `session.tool` | a tool use/result (normalized) | tool{name,input,output} |
| `session.reasoning` | reasoning/thinking surfaced | text |
| `session.plan` | a plan produced (plan-mode/.plan.md) | planRef |
| `session.prompt-detected` | an interactive prompt detected in output | prompt, expects |
| `session.approval-requested` | server backend asks approval | tool, request |
| `session.idle` | no activity within idle window (timer→event) | — |
| `session.stalled` | no activity past stall window (timer→event) | sinceMs |
| `session.rapid-death` | exited <rapidDeath after spawn (timer→event) | code, signal |
| `session.ended` | graceful end | outcome |
| `session.dead` | crash/forced kill | code, signal |

### `work.*` — messenger ingress & coordination (from messenger adapters)
| type | when | key payload |
|---|---|---|
| `work.appeared` | new work surfaced (the `work` object rides here) | workRef, kind |
| `work.claimed` | a claim succeeded | workRef, agent |
| `work.heartbeat` | claim liveness refreshed | workRef |
| `work.released` | claim released | workRef, outcome |
| `work.status` | progress published | workRef, status |
| `work.review-posted` | a review result published | workRef, verdict |

### `message.*` — messages as sources (KB ingest; messenger threads)
| type | when | key payload |
|---|---|---|
| `message.received` | a message arrived on a thread | threadRef, text, author |
| `message.sent` | Sumo posted a message | threadRef, text |

### `messenger.*` — distributed coordination (only when `can.distributed`)
| type | when | key payload |
|---|---|---|
| `messenger.proof-of-life-request` | a foreign claim needs liveness verification | agent, requestRef |
| `messenger.proof-of-life-response` | a liveness verdict published | agent, alive |

### `artifact.*` — ingestion (`agent-artifacts`)
| type | when | key payload |
|---|---|---|
| `plan.ingested` | a plan file ingested & normalized | planRef, sessionId |
| `transcript.ingested` | a transcript batch ingested | sessionId, count |
| `config.snapshot` | a harness config snapshot taken | sessionId, redacted |

### `orchestrator.*` — the actor's own emissions (from `sumo/orchestrator`, `source: 'orchestrator'`)
| type | when | key payload |
|---|---|---|
| `orchestrator.surfaced` | the orchestrator routes a condition to a human/messenger (a judgement it won't auto-decide: an unknown prompt, an unmodified approval, a proof-of-life answer, a post-stall reap) | reason, event{type,sessionId,payload} |

A relay plugin (e.g. a messenger) observes `orchestrator.surfaced` and presents it on its medium; core
stays medium-agnostic. Dedupe is `orch:surfaced:<sessionId|na>:<triggering-seq|reason>` (stable, so a
re-surface of the same condition collapses). The orchestrator also emits the `session.idle`/`session.stalled`
silence events above (dedupe `orch:<type>:<sessionId>:<epoch>`, one-shot per silence epoch).

### `plugin.*` / lifecycle / derived
| type | when | key payload |
|---|---|---|
| `plugin.installed` | a plugin/dependency installed | name, version |
| `plugin.unavailable` | a plugin/capability unavailable | name, reason |
| `ttl.swept` | TTL sweeper removed records | kind, count |
| `<plugin>:<custom>` | any plugin-emitted derived event | (plugin-defined) |

## Steering actions (NOT events — a separate vocabulary)

`before(action, fn)` steers on **action** names, not event types (a decision waterfall, not an
observation — CONVENTIONS §3b divergent #3). The action vocabulary:

| action | when the waterfall runs | a handler may |
|---|---|---|
| `tool` | before a tool executes | `{deny}` / `{event:modified-input}` / pass |
| `prompt` | before a prompt is submitted | `{deny}` / inject / pass |
| `finish` | before a turn/session finishes | `{deny}` (force continue) / pass |

Steering actions map to each harness's native mechanism in `12-hooks-and-steering.md`; capability
gaps degrade per the aligned capability-failure convention.

## Rules for adding event types

- A new adapter maps its native events onto **existing** `type`s where one fits (anti-drift, §3a);
  it invents a new `type` only for a genuinely new concept, and documents it here.
- Adapter-specific detail goes in `ext`, never a new top-level `type`, when the concept already exists
  (e.g. Claude `TodoWrite` is a `session.tool` with `ext`, not a new type).
- Derived/plugin events use a plugin namespace (`dependency:suggestion`) to avoid colliding with core.

## Compatibility considerations

-   Whether `session.output` (raw, high-volume) is on the main log or a separate
  lower-retention stream — it's noisy and mostly only the orchestrator's prompt-detector needs it.
  Recommend: a short-TTL raw substream, with normalized `session.message`/`session.tool` on the
  durable log.
-   Final namespacing for derived plugin events (`plugin:event` vs `event@plugin`).
- **Turn-level lifecycle (surfaced from Codex, current implementation).** Codex emits
  `task_started`/`task_complete` per *turn*, not per *session*; there is no session-termination
  semantics in them. The catalog has only session-level `session.started`/`session.ended`, so the
  Codex parser currently passes these through as `session.raw:task_started`/`session.raw:task_complete`
  rather than mis-mapping `task_complete`→`session.ended` (which would prematurely close a session).
  Recommend adding `turn.started`/`turn.ended` (payload: turnId, sessionId, outcome) if turn-level
  reactivity is wanted; otherwise document that turn boundaries stay in `ext`/passthrough.
- **Token/cost usage (surfaced from Codex, current implementation).** Codex `token_count` (and similar
  usage reports) have no normalized home. Options: a `session.usage` type (payload: tokenUsage,
  rateLimits), or carry usage in `ext` on an existing session event. Until resolved it is
  `session.raw:token_count` passthrough (the "declare, don't fake" rule — no fabricated field).
