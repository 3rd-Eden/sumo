# Sumo — Engineering Conventions (CONVENTIONS.md)

> This document is a **cross-cutting contract**. Every package and plugin in the Sumo
> monorepo MUST follow it. It is deliberately prescriptive so an implementing agent does
> not need to re-derive style or structure. Where it says MUST, it is not optional.

---

## 1. Language & module system

- **Language: plain ESM JavaScript, file extension `.mjs`.** There is NO TypeScript and NO
  build/transpile step for source. Code runs as authored on Node.
- **Node target:** Node 22 LTS or newer (top-level `await`, stable `node:test`, modern ESM).
  Confirm the exact floor in `package.json#engines`.
- **No compile-time types.** Because there is no type system at runtime, **all contracts are
  enforced at runtime by zod schemas** (see §3) and *documented* for editors via JSDoc
  typedefs (see §2). Do not rely on types for correctness — rely on validation.
- **Imports:** use explicit `.mjs` extensions in relative imports (`import { x } from './x.mjs'`).
  Use `node:` prefix for builtins (`import { createServer } from 'node:net'`).
- **No default-export-only modules** for anything another module must introspect; prefer named
  exports so the runtime can enumerate them.

## 2. JSDoc for editor support (optional static checking)

Author JSDoc `@typedef` / `@param` / `@returns` on all public functions and classes so editors
give autocomplete and `tsc --checkJs --noEmit` can lint without producing output. JSDoc is
**documentation and editor help only** — it is never the enforcement mechanism.

```js
/**
 * @typedef {Object} NormalizedTranscriptEvent
 * @property {string} id
 * @property {string} sessionId
 * @property {number} ts          - epoch ms
 * @property {'message'|'tool_use'|'tool_result'|'reasoning'|'plan'|'todo'} kind
 * @property {string} [text]
 * @property {Record<string, unknown>} ext - adapter-specific preserved fields
 */
```

A repo-root `jsconfig.json` with `{ "checkJs": true, "strict": true }` is RECOMMENDED so CI can
run `tsc --noEmit` purely as a linter. This adds a dev dependency on `typescript` but produces
no build artifacts.

## 3. zod is the contract

- Every boundary where data crosses from one trust/ownership domain to another (adapter →
  core, plugin config → plugin, socket message → daemon, hook payload → event log) **MUST
  `.parse()` the data through a zod schema** at that boundary.
- Schemas live in a `schema.mjs` file colocated with the contract they describe. The schema is
  the single source of truth; the JSDoc typedef is generated-from or kept-in-sync-with it.
- Validation **collects errors** where the result is user-facing (config, plugin manifests) and
  reports them via the unified `SumoDiagnostic` model — it does not throw on the first error
  for user-facing surfaces. Internal/programmatic boundaries may throw.
- Alternative considered: `valibot` (lighter bundle). **Decision: zod** for ecosystem
  familiarity and error ergonomics. Revisit only if startup cost becomes measurable.

## 3a. Anti-drift principle: prefer shared patterns across surfaces (MANDATORY)

Sumo has several surfaces and APIs (plugins, messenger adapters, harness adapters, transcript/hook
adapters, interfaces). **They must not drift into bespoke shapes.** Where a pattern can be shared
across surfaces, sharing takes preference over a surface-specific design. Before inventing a new
shape for a surface, check whether an existing Sumo pattern already covers it and specialize that
instead.

The shared skeleton every adapter surface obeys:

1. **A class extending a `sumo/<kind>` base**, which itself extends a common `sumo/adapter` base.
2. **`id` / `can` / `config` as instance class props** (not statics — everything is a class prop).
3. **Two fundamental operations, same vocabulary everywhere:**
   - **`read`** — *ingest*: turn the external world into normalized Sumo events/objects.
   - **`write`** — *act*: turn a Sumo intention into an external-world effect.
   A surface may add well-named domain specializations of these (the messenger keeps `work()` as a
   named ingest and `say`/`mark`/`status`/`review` as named `write` variants), but they dispatch
   through the *same* base machinery — they are not a second mechanism.
4. **Registration via a flat verb** mirroring `use`: `sumo.messenger(Class)`, `sumo.harness(Class)`.
5. **One event log, one daemon, one dedupe/merge rule, one `ext`-bag enrichment, one
   redaction-on-egress.** No surface gets its own eventing or storage path.
6. **Declare capabilities (`can`), degrade, never fake.**
7. **One parametrized conformance suite per surface**, all asserting the same core contract.

**The `sumo/adapter` common base** owns: `id`/`can`/`config` introspection, registration, zod
validation, the event-emission path (with dedupe/merge — see `01`/`02`), capability degradation, and
the conformance harness. Kind-specific bases (`sumo/messenger`, `sumo/harness`) add ONLY their
primitive vocabulary on top. **A new surface specializes `sumo/adapter`; it does not invent its own
shape.** This is what keeps the ecosystem coherent as it grows.

The `read`/`write` duality is also the Primus/Spark Duplex vocabulary used for harness transports
(`05-harness-api.md`), so it composes: a harness `read`s frames from its transport and `write`s
actions to it; a messenger `read`s work from its medium and `write`s replies to it. One Duplex-shaped
mental model across surfaces.

## 3b. Align where surfaces touch; diverge only with cause (MANDATORY)

§3a says prefer shared patterns. This section is the *review lens* for applying it: when two surfaces
differ at a contract boundary, ask whether the difference is **essential to the domain** or merely an
**artifact of designing the surfaces separately**. Keep the essential; align the accidental. Align by
default, diverge only with stated cause. The point is NOT to make everything the same — it is to stop
incidental drift.

### Aligned conventions (every surface that touches these uses the same shape)

1. **Outcome envelope for fallible operations.** Any operation that can fail or reports state returns
   a tagged result, never a mix of raw-return / sentinel / throw:
   ```js
   /** @typedef {{ ok: true, value?: any } | { ok: false, reason: string, code?: string, ... }} Result */
   ```
   Adopted by: messenger `claim` (`{ ok, heldBy }` is this shape), `mark`, session control calls,
   command handlers that can fail, and any future fallible contract. A developer learns the outcome
   shape once. (Operations that genuinely cannot fail may return their value directly.)

2. **Capability-failure behavior.** Invoking something `can` reports as unsupported does the SAME
   observable thing everywhere: it returns `{ ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason }`,
   which the runtime surfaces as a `SumoDiagnostic`. It never throws, never silently no-ops, never
   fakes success, and never silently substitutes a different behavior. (A surface MAY document an
   explicit, declared fallback — e.g. messenger `status` defaulting to `say` — but that is a declared
   capability, reflected in `can`, not a silent substitution.)

3. **Event/object envelope.** Everything that flows in — harness events AND messenger work items —
   shares the same wrapper conventions: normalized fields + an `ext` bag for adapter-specific data +
   a `dedupe` key (§01/§05). The *wrapper* is aligned; the *payload type* is not collapsed (see
   divergent #2).

4. **Error vs. return rule.** A single convention: **contracts return `Result` for expected/operational
   failures** (claim lost, capability unsupported, external call rejected); **they throw only for
   programmer error** (bad arguments, contract violations, missing required override). User-facing
   collection points (config, plugin load) gather thrown errors into `SumoDiagnostic[]` rather than
   failing on the first. No contract mixes "throw sometimes, return failure other times" for the same
   class of outcome.

### Deliberately divergent (do NOT force these together)

1. **Ingest vs. act shapes.** `read` produces a stream; `write` performs an effect. Essential
   ingest-vs-act difference, not drift.
2. **Event vs. work-item payload.** A harness event is *something that happened* (a data record); a
   messenger work item is *something to do* (carries bound action methods). Genuinely different domain
   objects. They share the envelope (aligned #3) but are not one type. Collapsing them would be
   over-unification.
3. **Decision shape vs. outcome envelope.** Steering's `before` return (`{ deny }` / merged object /
   nothing) is a *decision*, not an *outcome report*. A decision drives a waterfall (merge/bail); an
   outcome reports what happened. Different purposes → different shapes, intentionally.

### Process

When adding or reviewing any surface/contract: walk the four aligned conventions and confirm the new
contract uses them where it touches those concerns; for any difference, record whether it is essential
(cite which divergent case) or accidental (then fix it). This check is part of every adapter/surface
conformance review.

## 3c. Surface, don't act — the orchestrator is the sole actor (MANDATORY)

Every package except the orchestrator is a **sensor** and/or an **effector**. None of them *decides*
or *acts on its own observations*.

- **Sensor:** an adapter/session/hook/messenger turns the outside world into normalized events on the
  one log (`read`/ingest). The session that sees a Claude "upgrade banner" in stdout **emits an
  event**; it does not decide to dismiss it.
- **Effector:** the same package *exposes* effect primitives (`session.key`, `session.send`,
  `work.reply`, `session.respondApproval`) — but does not pull those triggers based on its own
  observations. They exist for the orchestrator to drive.
- **Actor:** the **orchestrator** is the only thing that both sees the full event stream and holds the
  authority to act. It interprets a surfaced condition and drives the effector (sees the banner event
  → calls `session.key('Enter')`).

Why centralized: if adapters acted on their own observations, decision logic would scatter across
every package, each acting on partial local information, with no single auditable, guard-bounded
place. Keeping adapters dumb (surface + expose) and the orchestrator the single brain means all
process-management decisions live in one place that has the complete picture and is bounded by the
runaway guards. New conditions are handled in the orchestrator/plugins **without touching any
adapter**, because the adapter already surfaced the raw material.

Consequence for package design: **business logic does not live in the packages.** `session`,
`agent-artifacts`, `hooks`, the messenger/harness adapters — all stay pure mechanism. The "why/when"
(dismiss this banner, auto-answer this prompt, back off on this rate-limit, spawn a reviewer now)
is orchestrator logic, with project-specific overrides hooking in via a partial-object modify
(`10-orchestrator.md`). This is also why `session.key`/`send`/`respondApproval` and `work.reply`
(`03a`) are exposed primitives rather than adapter-internal conveniences: they are the **effector
surface the orchestrator acts through.**

## 3d. Small packages, dedicated focus, clear boundaries (MANDATORY)

Sumo is a monorepo of **small packages split by concern**, not bundled by feature. A package does one
thing; packages that need a shared concern **depend on a third focused package** rather than one
reaching into another or duplicating it. This keeps boundaries clear and each package independently
testable, versionable, and potentially useful outside Sumo.

The governing axis is **concern, not source or feature.** Worked example (the agent-artifacts split):

- **Parsing** (per-harness transcript format knowledge) → a focused `jsonl` package. Input: raw
  transcript bytes/records; output: normalized events. No I/O, no tailing, no correlation.
- **Acquisition + correlation** (where artifacts live, tail vs import, matching native sessions to
  Sumo ids) → `agent-artifacts`. It *uses* `jsonl` as a dependency to parse what it reads.
- **Control** (spawn, transport, steer, lifecycle) → the harness adapter. Its `read()` *delegates*
  to `jsonl` to normalize live-stream frames rather than embedding a parser.

So the same parser serves both the live stream (harness) and the on-disk transcript
(agent-artifacts) as a **shared dependency** — not a cross-boundary reach and not duplicated. A
format divergence (e.g. Claude's live `stream-json` vs on-disk `.jsonl` differ) stays **encapsulated
inside `jsonl`** (it may expose two parse entry points), invisible to both consumers.

Rule when adding functionality: if it is a distinct concern, it is a (possibly new) focused package
or module, depended upon — not bolted onto an existing package or copied. Resist bundling; prefer a
shared focused dependency.

## 3e. Ingestion is lossless; normalization is additive, never subtractive (MANDATORY)

Normalization **adds** a common view over raw data; it never **removes** data that doesn't fit. This
is a foundational guarantee, not a nicety — it is what makes  (preserve adapter-specific data),
 (no invented parity), §3c (surface, don't act), and the dedupe/`ext`-merge enrichment () all
coherent. If anything were dropped on ingest, it could never be preserved, enriched, or reacted to
later.

Rules:
- **Nothing is dropped on the ingestion path.** Every hook, event, and artifact surfaces. An event
  that normalizes cleanly gets common fields *and* preserved raw; an event that **cannot** be
  normalized still surfaces as a **passthrough** event (raw in `ext`, a generic/namespaced `type`,
  empty normalized fields) — never silence. "I don't know how to normalize this" MUST produce a
  preserved event, not a dropped one.
- **The only place data is removed is the TTL sweeper** (`01`), by age, deliberately and
  configurably — never the ingestion path, never by un-normalizability.
- A plugin can always `on(...)` a harness's idiosyncratic event via its preserved/`ext` payload, even
  if no cross-harness plugin would. The adapter does not get to decide that event is unimportant — that
  is the orchestrator's/plugin's call (§3c).

> **Lossless requirement:** an earlier capture experiment dropped hooks
> it cannot normalize. That is a bug relative to Sumo's intent. Sumo adopts capture corpus's *additive*
> normalization (extract common fields, preserve raw — its `normalized event model` model) but **corrects the lossy
> drop**: un-normalizable ≠ discardable.

## 3f. Capture-first, fixture-backed support (MANDATORY)

A harness/event is not "supported" on a claim — it is supported on **evidence**. Adopted from the
maintainer's `capture corpus` support policy: a tool/event is supported only when (1) a real native payload
has been captured, (2) the capture is scrubbed and committed as a fixture, and (3) conformance tests
pass against that fixture. Handwritten payload mocks may test the pipeline itself, but never stand in
for a real contract. This replaces secondary-sourced capability claims (the June matrix) with
captured-and-tested reality, and it is why every adapter conformance suite (§4) runs against committed
real fixtures, not invented ones.

Reference implementations follow the same rule. A reference plugin, messenger, adapter, or harness is
allowed only when it is a fully working, production-shaped implementation that provides real behavior
through Sumo's public contracts and could ship as part of the project. It must not exist merely to
trigger branches, replace internals, or impersonate another component. For example, a reference HTTP
messenger may expose real routes for work ingestion, replies, claims, status, review, and liveness;
an inline messenger that yields one handcrafted object for a test is a fake and is forbidden.

## 4. The adapter convention (MANDATORY — one unified idiom for ALL adapters)

Adapters are how Sumo integrates external systems: **harness** adapters (Claude Code, Codex,
OpenCode, Cursor) and **messenger** adapters (GitHub, Slack, Jira, …). Both families use the **same
idiom** (per §3a), so a developer learns one adapter pattern, not two:

- **Extend a Sumo-provided base class** (`sumo/messenger`, `sumo/harness`, or a package-local base
  like `TranscriptAdapter`). The base owns the contract + all shared machinery (lifecycle, claims,
  mirror, correlation, redaction, capability gating, event emission). The developer overrides only a
  small set of short **medium/harness primitives**.
- **Register via a flat verb**: `sumo.messenger(MyAdapter, opts)` / `sumo.harness(MyAdapter, opts)`.
  Sumo instantiates, validates the contract (zod), and wraps it in the runtime. Registration stays
  house-style (mirrors `sumo.use(plugin)`); authoring is class-based because there is genuinely
  shared machinery to inherit. **The base class is the one place `extends` appears in a developer's
  world** — everything else (plugins, the host surface) is functions and verbs.
- **Declare capabilities; never fake them.** `static can = {...}` states what the medium/harness
  supports. Unsupported operations degrade to a `SumoDiagnostic`, never a silent no-op or fake
  success. The same word `can` is used author-side (`static can`) and consumer-side (`work.can.*`).
- **`static id` / `static can` / `static config`** are static so Sumo can introspect them BEFORE
  instantiation (validate config, register the id, show in `sumo doctor` without side effects).

Package structure (applies to any adapter-hosting package):

```
packages/<package>/
  src/
    base/
      <Kind>.mjs              # the base class authors extend (or provided via sumo/<kind>)
      schema.mjs              # zod schema = the validated contract
    adapters/
      github/index.mjs        # class GitHubMessenger extends Messenger
      slack/index.mjs
    index.mjs                 # registry: exports adapters by id
  test/
    conformance.test.mjs      # ONE parametrized suite run against EVERY adapter
    fixtures/<id>/...          # captured real artifacts/fixtures per adapter
```

### Naming rules for the authoring surface (the methods developers type)

- A primitive is a domain noun or single plain verb — never `verb+Noun+Qualifier`. (Messenger:
  `work`/`say`/`mark`, not `pull`/`postMessage`/`setClaimMarker`.)
- Behavior-by-argument over method-proliferation where it stays obvious (`mark(ref, who)` reads/sets/
 clears by argument — the the handler engine.scoped provider arity instinct).
- Same concept, same word on author and consumer sides (`can` ↔ `work.can`).
- Inherited machinery nobody types may keep fuller names (`startHeartbeat`, `reclaimExpired`) —
  clarity over brevity for code developers don't write.

Rules:

1. **Shared base class owns the common concept and the validation.** Concrete shared logic
   (correlation, redaction hand-off, capability gating, claim/TTL lifecycle) lives in the base. The
   base exposes a public method that calls a protected primitive and then validates the result:

   ```js
   // base/TranscriptAdapter.mjs
   import { NormalizedTranscriptEventSchema } from './schema.mjs';

   export class TranscriptAdapter {
     /** @type {import('../types.mjs').HarnessId} */
     harness;
     /** @type {import('../types.mjs').TranscriptCapabilities} */
     capabilities;

     /** Subclasses implement the harness-specific mapping only. */
     // eslint-disable-next-line class-methods-use-this
     _normalizeOne(/* raw */) { throw new Error('abstract'); }

     /** Public entry: enforces the contract at the boundary. */
     normalize(raw) {
       const out = this._normalizeOne(raw);
       return NormalizedTranscriptEventSchema.parse(out); // <- the contract is enforced here
     }
   }
   ```

2. **Subclasses implement ONLY the differences.** No subclass re-implements validation or
   shared flow. A subclass that needs to preserve harness-specific data puts it in the `ext`
   bag of the validated shape — never by widening the common schema.

3. **Adapters declare capabilities; they never fake them.** The `capabilities` descriptor states
   what the harness actually supports for this package's domain (e.g. can this hook adapter
   `deny`? can it `modify input`?). Unsupported operations degrade per the package's documented
   fallback chain and emit a diagnostic — they MUST NOT silently no-op or pretend success. This
   is how the "no invented parity across harnesses" rule is enforced mechanically.

4. **One conformance suite, parametrized over all adapters.** This is what "validate and test
   against" means concretely:

   ```js
   // test/conformance.test.mjs
   import { test } from 'node:test';
   import assert from 'node:assert/strict';
   import { allAdapters } from '../src/index.mjs';
   import { NormalizedTranscriptEventSchema } from '../src/base/schema.mjs';
   import { fixturesFor } from './fixtures/index.mjs';

   for (const adapter of allAdapters) {
     test(`${adapter.harness}: normalize() output validates`, () => {
       for (const raw of fixturesFor(adapter.harness)) {
         assert.doesNotThrow(() =>
           NormalizedTranscriptEventSchema.parse(adapter.normalize(raw)));
       }
     });
     test(`${adapter.harness}: preserves adapter-specific data in ext`, () => {
       /* assert no raw field was dropped that the fixture marked as preserve */
     });
     test(`${adapter.harness}: declares only real capabilities`, () => {
       /* assert capability flags match what the fixtures exercise */
     });
   }
   ```

5. **Each capability package defines its OWN base class + schema** (a `HookAdapter` decision
   schema is not a `TranscriptAdapter` event schema), but the *pattern* — base class validates,
   `adapters/` folder, zod output contract, parametrized conformance suite — is identical
   everywhere.

## 5. Testing

- Use the built-in `node:test` runner and `node:assert/strict`. No external test framework
  required for 1.0.
- Conformance suites (above) are mandatory for every adapter package.
- Fixtures are **captured real artifacts** from each harness, committed under
  `test/fixtures/<harness>/`, with secrets pre-redacted. Treat them as version-pinned snapshots
  and note the harness version each was captured from.
- **Live by default. No mocks that impersonate a component.** Tests exercise REAL
  components against REAL boundaries, and live tests run by default — there is no opt-in env gate
  (`SUMO_LIVE_CAPTURE` and friends are gone). A fake that stands in for a real component's behavior —
  a mock transport impersonating a subprocess, a stubbed daemon/client, a fake adapter — is
  forbidden: it asserts an invented shape and cannot fail the way reality fails (the mock that passes
  while live fails is the proof). The allowed input is the opposite case: a **real captured artifact**
  (a committed, scrubbed transcript) fed into a **real component** (the parser) — that is capture-first
  (§3f), not a mock.
- **No test-only Sumo substitutes.** Tests MUST NOT use fake harnesses, fake messengers, fake sessions,
  fake daemon clients, test-only provider registrations, monkey-patches, polyfills, or internal API
  overrides to avoid running production code. If the real external dependency is unavailable, the test
  skips with the real prerequisite or is handed off to an environment that has it; it does not invent a
  substitute. Any exception requires explicit maintainer sign-off.
- **Package implementations are not mocks.** `memory-level` is allowed when the contract under test is
  the Level-compatible storage abstraction itself. Daemon ownership, IPC, lifecycle, locking,
  cross-process behavior, and integrations must use the real daemon and `classic-level`.
- **Coverage is source-scoped and behavioral.** Line, branch, and function coverage all gate at 90%.
  Branch/function coverage matter because decisions live in branches and callable surfaces, not just
  executable lines.
- When a test needs a real dependency that is unavailable in the environment, it uses the shared
  `_live.mjs` helpers to surface a clear reason. Harness-specific live tests skip via `t.skip(reason)`
  when the required real harness or CLI is absent; they never silently pass and never substitute a
  mock fallback. A live test that has its real dependency and then fails is still a real regression.

## 5a. Core capabilities vs plugins (MANDATORY)

Built-in harness and messenger adapters are **core capabilities** the system provides — registered
automatically at startup. The `plugins/` directory is for genuinely optional, adapter-neutral behavior
a user opts into. Never package core functionality as a plugin, and never leave a demonstration or
test fixture in `plugins/` as if it were a shipped feature.

Concretely: Claude/Codex/Cursor support IS Sumo — requiring a `harness-claude-code` plugin entry in
`use:` to get Claude support is like requiring a "typescript-support" plugin to use TypeScript. Core
adapters auto-register from the harness package's registry; their config lives under the core
`harness.<id>` section (not `plugins.<id>`). Demonstration workflows belong in the tests that prove
them, not in `plugins/` masquerading as features.

## 6. Monorepo & packages

- pnpm workspace. Packages live under `packages/*`. The base package is `sumo`.
- Packages avoid business logic; the `sumo` base package + plugins provide glue/policy.
- Initial subpath exports off the base package: `sumo/db`, `sumo/agent-artifacts`,
  `sumo/session` (note: `headless` → `session`, and `jsonl` → `agent-artifacts`; see the main
  spec §6 and §10). These may later become standalone packages.

## 7. Style

- Minimal formatting in code comments; prefer prose JSDoc over decorative banners.
- Errors are `Error` subclasses carrying a stable `code` (e.g. `SUMO_PLUGIN_DEP_MISSING`) that
  maps to a `SumoDiagnostic.code`.
- Files created at runtime under `~/.sumo` are mode `0600` (files) / `0700` (dirs); the daemon
  socket is `0600`. See main spec §12.
