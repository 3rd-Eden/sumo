# 08 — `sumo/transcript` Transcript Parser (focused package)

> Claude's live `stream-json` and on-disk `.jsonl`
> formats **diverge**. Live (`claude -p --output-format stream-json --verbose`): one object/line
> with required `type` (`system`/`assistant`/`user`), `system:init` carries
> `session_id`/`cwd`/`model`/`tools`/`mcp_servers`, plus runtime-only events like `system/api_retry`.
> On-disk (`~/.claude/projects/<enc-path>/<uuid>.jsonl`): typed records **linked by `parentUuid`**,
> including summaries and git snapshots — persistence-only structure. Same message content, different
> envelope. This is why the parser exposes **two entry points**, one per format.
> The parser normalizes additively, preserves native data, uses per-tool adapters, and relies on
> captured fixtures. It never drops an unrecognized record (CONVENTIONS §3e).
>
> Read with `CONVENTIONS.md` §3d (small focused packages), `05` (harness `read` delegates here),
> `07` (the normalized event types this emits), `09`/agent-artifacts (the on-disk consumer).

## Why a separate package (not part of harness or artifacts)

Per §3d, parsing is a **distinct concern** — per-harness transcript format knowledge — used by **two**
consumers: the harness adapter (live stream frames) and `agent-artifacts` (on-disk transcripts). It
is a focused, dependency-shared package so the parser exists **once**, neither duplicated nor reached
across a boundary. It does only parsing: no I/O, no tailing, no correlation, no storage. Bonus: a
standalone Claude/Codex/Cursor transcript parser is independently useful and testable.

## The contract — a `sumo/transcript` adapter (follows the adapter convention)

> The package/base is **`sumo/transcript`** (not
> `sumo/parser`); dir `packages/transcript/`, root export `./transcript`. The base class is `Parser`;
> subclasses are `<Harness>Transcript extends Parser`. There is no public `sumo.transcript()` verb.

A parser **is an adapter** (CONVENTIONS §4): it is per-harness, capability-varying, keyed on the four
harness ids, and conformance-tested — the textbook definition. So it follows the unified idiom: a
class extending a `sumo/transcript` base, declaring `id`/`can`/`config` as instance props, covered by
the one parametrized conformance suite. It is **its own focused package** (§3d) but an **internal adapter
family composed by the harness adapter, not separately registered** — no one registers a parser
without a harness, so there is no public `sumo.transcript()` verb; the harness adapter declares which
parser it uses and pulls it in.

A parser turns one harness's raw transcript unit into **normalized events targeting the `07`
event-catalog vocabulary** (`session.started`/`session.message`/`session.tool`/`session.reasoning`/
`session.ended`, plus `session.raw:<native>` passthrough).
It does NOT emit; it returns events for a consumer to emit. Per-harness format knowledge lives here.

```js
import { Parser } from 'sumo/transcript';

export class ClaudeTranscript extends Parser {
  id  = 'claude-code';
  // `can` — same word as everywhere (§3b). Which entry points this harness's parser supports.
  can = { stream: true, file: true };
  config = z.object({});   // most parsers need none

  // The base owns the public `stream(frame)`/`file(record)` (capability gate + output validation);
  // subclasses implement only the mapping hooks. Two hooks because live and on-disk formats diverge:
  *onStream(frame) { /* parse one LIVE stream frame  → normalized 07 events */ }
  *onFile(record)  { /* parse one ON-DISK record     → normalized 07 events */ }
}
```

- **`stream(frame)`** — parse one live frame (a `stream-json` line, or an SSE-derived object). Used by
  the harness adapter's `read()`.
- **`file(record)`** — parse one persisted transcript record. Used by `agent-artifacts` when
  tailing/importing on-disk transcripts.
- **`can`** — declares which entry points exist (the convention's capability word, not `provides`).
  OpenCode has no on-disk JSONL (live SSE only) → `can = { stream: true, file: false }`.
  Claude/Codex/Cursor → both. Invoking an unsupported entry point returns the shared
  `SUMO_CAP_UNSUPPORTED` failure (§3b), like any other capability gap.
- **Both entry points MUST normalize to the SAME `07` event shape**, so whichever source a given
  logical event arrives from, it normalizes identically — which is what lets the daemon's `dedupe`
  collapse the live + on-disk copies (`05`/`01`/`02`). Format-envelope differences (Claude's
  `parentUuid` threading, summaries, git snaps on disk; `api_retry` in the live stream) are absorbed
  here and never surface to consumers.

### Parsers MUST target the shared `07` vocabulary (cross-harness normalization)

This is the rule that makes four divergent harnesses queryable uniformly: a parser does **not** invent
its own event types. Claude `TodoWrite`, OpenCode tool parts, and Codex tool items all normalize to
the **same** `07` types (a `TodoWrite` is a `session.tool` with detail in `ext` — there is no
`session.todo` type), so a consumer (KB, orchestrator) never has to know which harness produced an
event. (Note: `session.plan`/`.plan.md` plans are NOT produced by transcript normalization in this
build — no plan construct appears in the captured transcript streams; plan files are ingested by
`agent-artifacts` (`09`). `session.plan`/`session.output` are therefore not in this parser's emitted
set yet — see "Emitted vocabulary" below.) The `07-event-catalog.md` vocabulary is the shared target
contract; harness-specific structure that doesn't fit a common field is **preserved in `ext`** (not a
new top-level type) — the §3a/§07 rule. Conceptual normalization (same meaning → same type) happens
**here, in the parser**; it is per-harness knowledge and belongs nowhere else.

## Normalization rules (shared by all parsers)

- Output is the normalized event envelope (`07`): normalized fields + `ext` bag for adapter-specific
  structure (Claude `TodoWrite`, OpenCode part types, Codex token-usage, Cursor old/new edit strings).
- **Lossless — never drop (CONVENTIONS §3e), for recognized records too.** A record the parser
 recognizes emits a normalized event with common fields **and** its native source preserved under
 `ext.native` (the originating record verbatim; block-level events also carry `ext.block`/`ext.item`/
 `ext.part`). Harness-specific fields (Claude `cwd`/`gitBranch`/`parentUuid`, Codex token usage,
 Cursor model) are NOT lifted into a separate curated bag — they are preserved as-is inside
 `ext.native`, so nothing is lost and the parser stays simple. A record it does NOT recognize still
 emits a **passthrough event**: raw in `ext.native`, the native event name namespaced as the `type`
 (e.g. `session.raw:<native>`), empty normalized fields. The parser MUST NOT return nothing for an
 unrecognized record. (Corrects `capture corpus`'s lossy-drop — see header.)
- **Each event must carry the data needed to derive its `dedupe` key** — prefer the artifact's natural
  id; the consumer/daemon falls back to a content hash when absent (`05`/`01`). The parser surfaces
  the natural id **per emitted event**, not per record: one native record (an assistant message)
  expands into many events (text + thinking + N tool blocks), so a single record `uuid` would make
  them collapse wrongly. Prefer an intrinsic block/tool id (Anthropic `tool_use.id`/`tool_use_id`,
  Codex `call_id`, OpenCode `part.id`); otherwise `<recordId>#<blockIndex>`. This id is what makes the
  `stream`↔`file` dedupe keys equal for the same logical event AND keeps sibling events distinct.
- **Deltas vs finalized frames.** Live streams emit incremental updates (Cursor
  `--stream-partial-output`; OpenCode `message.part.delta` + repeated `message.part.updated`). The pure
  per-record parser maps a part/message to a normalized `session.*` event only on a **finalized**
  frame; pure delta frames surface as `session.raw:<native>` passthrough (lossless). Cross-frame
  accumulation is the consumer's concern, not the stateless parser's.
- `kind` ∈ {message, tool_use, tool_result, reasoning, plan, summary, system} (maps to `07`
  `session.*` types). Persistence-only kinds (summary, git-snap) parse from `file` only.
- No redaction here (that is the consumer's storage-time concern, `16`); the parser preserves content.

## Per-harness parsers (adapter layout, §4)

```
packages/transcript/              # focused package; `sumo/transcript` base lives here
  src/
    base/
      Parser.mjs        # the base class authors extend; public stream/file + capability gate + validation
      schema.mjs        # zod contract (NormalizedEvent + KNOWN_TYPES)
      blocks.mjs        # shared Anthropic content-block normalizer (Claude stream+file reuse)
    adapters/
      claude-code/index.mjs  # class ClaudeTranscript extends Parser; stream()=stream-json, file()=projects/*.jsonl
      codex/index.mjs        # stream()=codex app-server `thread/*`/`turn/*`/`item/*` JSON-RPC notifications; file()=rollout-*.jsonl
      cursor/index.mjs       # stream-json / agent-transcripts
      opencode/index.mjs     # SSE-derived objects; can.file=false
    index.mjs              # registry by harness id (composed by the harness adapter)
  test/
    conformance.test.mjs   # ONE parametrized suite (the dedup-correctness property below)
    contract.test.mjs      # base + schema unit tests
    fixtures/<id>/{stream,file}/...  # captured real live frames + on-disk records per harness
```

> **Codex `stream` surface (resolved 2026-06-22, verified against `codex-cli 0.140.0`):** the 1.0 Codex
> read surface is `codex app-server` JSON-RPC notifications (`05`), NOT `codex exec --json`/rollout
> `event_msg`. The real protocol (from the app-server's generated schema and a live capture) is a
> `thread`/`turn`/`item` model: `thread/started` → `session.started`; `item/completed` carries an
> `item` whose `type` (`userMessage`/`agentMessage` → `session.message`, `reasoning` →
> `session.reasoning`, `commandExecution` → `session.tool`) drives the mapping; `turn/started`,
> `turn/completed`, `item/started`, `item/agentMessage/delta`, and `thread/tokenUsage/updated` pass
> through. Codex `turn/*` is **turn-level**, not session lifecycle → passthrough until a `turn.*` type
> exists (see `07` compatibility considerations), never `session.ended`. The on-disk `rollout-*.jsonl` (the `file()`
> surface) is a *different* record set (`session_meta`/`response_item`/`event_msg`); to avoid
> double-emitting, `file()` normalizes `response_item/*` and passes every `event_msg/*` through.

## Conformance

One parametrized suite (per `CONVENTIONS.md`) across every parser, over **real captured transcripts**
(capture-first, §3f) — not invented mocks. It asserts: schema validity of every emitted event; the
stream↔file identity property (below); lossless passthrough (unrecognized record → preserved
`session.raw:<native>`, never dropped, §3e); `can`-honesty (unsupported entry → `{ok:false,
code:'SUMO_CAP_UNSUPPORTED'}`); cross-harness normalization (each harness's message/tool/reasoning →
the shared `07` type); and per-event id uniqueness (a multi-block record yields distinct ids).

**Stream↔file identity — the realized truth (verified from real captures, current implementation).** The ideal is
that the same logical turn from both surfaces produces an identical normalized event AND an identical
`dedupe` key, so the daemon collapses them. Reality differs *per harness*, and the suite asserts each
at the level it actually supports (the public `sumo/db/dedupe` helpers):
- **Claude — full collapse (`natural-id`).** The assistant `message.id` (`msg_…`) is identical across
  stream and on-disk (the record `uuid` is NOT — never dedup on it); payload identical → keys collapse.
- **Codex — payload identity only (`normalized`).** Same normalized `{type,payload}`, but the stream
  carries an `item.id` the rollout `response_item` lacks, so messages share no natural id. Tool calls
  DO share `call_id` and collapse. Plain-message cross-source collapse needs the daemon/correlation
  layer (`09`), not the parser — this is a surfaced finding, not a parser bug.
- **Cursor — type identity only (`divergent`).** No id on either surface, and the on-disk text is
  query-wrapped (`<user_query>…`) and can diverge from the live text → no parser-level collapse.
This is *the* property daemon dedup depends on, so it is encoded honestly rather than asserted
uniformly. A separate opt-in `*.live.test.mjs` (gated by `SUMO_LIVE_CAPTURE=1`) re-runs the real CLIs/
app-server and re-validates, so a harness format change breaks loudly instead of going stale.

## Compatibility considerations

-   Package/base name → **`sumo/transcript`** . The old `jsonl`
  filename is inaccurate (OpenCode is SSE, not JSONL); the package is `sumo/transcript`.
-   The two divergent Claude formats DO share most normalization:
  both carry the same Anthropic message content blocks, so a shared `blocks.mjs` normalizer handles
  text/thinking/tool blocks and only the envelope (system/init, result, `parentUuid`/`uuid`) differs
  per entry point.
-   Codex `task_complete`/`task_started` (turn-level) and `token_count`
  (usage) have no `07` home; proposed additions `turn.started`/`turn.ended` and `session.usage` are
  raised as `07` compatibility considerations. Until assigned a normalized event they remain
  `session.raw:<native>` passthrough.
