# `sumo/transcript` — per-harness transcript parsers

Turns each harness's raw transcript units — live stream frames **and** on-disk records — into
normalized events. It exists once and is shared by the two layers that ingest transcripts:
[`sumo/harness`](../harness) for live reads and [`sumo/agent-artifacts`](../agent-artifacts) for
on-disk tail/import, so neither duplicates format knowledge.

Imported as `sumo/transcript`.

> **Scope.** Parsing only — a **pure, stateless-per-record** function: one raw record in, normalized
> events out. **No** I/O, tailing, correlation, storage, redaction, or `sumo/db` import. It
> surfaces an artifact's natural id but does **not** compute the final `dedupe` key, and it never
> fabricates a field a harness didn't produce. Acquisition/correlation is `agent-artifacts`;
> the event hub is `sumo/db`. There is **no** public `sumo.transcript()` verb; the registry is
> composed by the harness adapter.

---

## The contract

A parser **is an adapter**: a class extending `Parser`, declaring `id` / `can` / `config` as
instance props, covered by one parametrized conformance suite. The base owns the machinery; a subclass
implements only the harness mapping.

```js
import { Parser } from 'sumo/transcript';

export class ClaudeTranscript extends Parser {
  id  = 'claude-code';
  can = { stream: true, file: true };   // which entry points exist
  config = z.object({});

  *onStream(frame)  { /* one LIVE frame    → normalized 07 events */ }
  *onFile(record)   { /* one ON-DISK record → normalized 07 events */ }
}
```

- **`stream(frame)` / `file(record)`** are the public entry points (the base owns them). They gate on
  `can`: an unsupported entry point returns the shared `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }`
  Result. It never throws or silently no-ops for unsupported capability. A supported entry point returns an iterable of
  events, each validated against `NormalizedEvent` before it leaves the parser.
- Subclasses implement the generator hooks **`*onStream` / `*onFile`**.

### Output: `NormalizedEvent`

A precursor to `sumo/db`'s `EventInput` — same field names, so it drops straight into `db.append`
once the consumer adds the `dedupe` key and `source`. Deliberately **no `dedupe`** (the daemon owns
it) and **no `source`** (the consumer knows live-vs-disk; omitting it keeps `stream`/`file` output
identical for the same logical event).

| field | meaning |
|---|---|
| `type` | a `KNOWN_TYPES` member, or a `<domain>.raw:<native>` passthrough |
| `payload` | normalized cross-harness fields (empty for passthrough) |
| `ext` | preserved native source: `ext.native` = the raw record (+ `ext.block`/`item`/`part`) |
| `id` | surfaced **per-event** natural id (block/tool id), if the harness provides one |
| `sessionId`, `ts` | when the record carries them |

`KNOWN_TYPES` (the emitted set) is `session.started` / `session.message` / `session.tool` /
`session.reasoning` / `session.ended`, plus `session.raw:<native>`. The schema refinement **rejects
any other top-level type** — an un-normalized record MUST surface as a `raw:` passthrough, so a parser
can never silently invent a type. (`session.plan`/`session.output` are valid `07` types but are not
emitted here — no transcript construct produces them; plan files are ingested by `agent-artifacts`.)

---

## The four harnesses

| harness | `stream()` surface | `file()` surface |
|---|---|---|
| `claude-code` | `stream-json` lines (`system`/`assistant`/`user`/`result`) | `~/.claude/projects/<enc>/<uuid>.jsonl` |
| `codex` | `codex app-server` JSON-RPC notifications (`thread/*`·`turn/*`·`item/*`) | `~/.codex/sessions/.../rollout-*.jsonl` |
| `cursor` | `stream-json` (mirrors Claude's envelope) | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` |
| `opencode` | SSE bus events (`{type, properties}`) | **none** — SQLite store → `can.file = false` |

Cross-harness normalization is the point: every harness's message/tool/reasoning construct maps to the
**same** `07` type, with harness specifics preserved in `ext.native` (never a new top-level type — a
Claude `TodoWrite` is a `session.tool` with detail in `ext`, not a `session.todo`).

### Dedup reality (read before relying on cross-source collapse)

The daemon collapses the live + on-disk copies of one logical turn by `dedupe` key. That only works
where both surfaces yield the **same** key — verified per harness from real captures:

- **Claude — full collapse.** The assistant `message.id` (`msg_…`) is identical across stream and disk
  (the record `uuid` is **not** — never dedup on it). Proven in the conformance suite.
- **Codex tools — full collapse.** The app-server item id and the rollout `function_call`/`_output`
  share `call_id`. Proven.
- **Codex plain messages, Cursor messages — no parser-level collapse.** These carry no shared natural
  id across surfaces (and Cursor's on-disk text is query-wrapped), so the same turn from the live
  stream and the on-disk file would **duplicate**. The parser cannot close this from where it sits;
  it is a surfaced, *unsolved* gap that needs a daemon/`agent-artifacts` decision (a source-independent
  `position`, or skipping already-seen records). The conformance suite
  encodes each harness at the level it actually achieves (`natural-id` / `normalized` / `divergent`)
  rather than asserting a collapse that doesn't happen.

### Lossless

Nothing is dropped. An unrecognized record → `session.raw:<native>` (raw in `ext.native`, normalized
fields empty). A *recognized* record whose body drifts to an unexpected shape also surfaces as a
passthrough rather than yielding nothing. Live delta frames (OpenCode `message.part.delta`) pass
through; only finalized frames normalize (cross-frame accumulation is the consumer's job, not the
stateless parser's).

---

## Usage

```js
import { parsers, isResult } from 'sumo/transcript';

const parser = new parsers['claude-code']();      // registry keyed by harness id

for (const frame of liveStreamFrames) {
  const out = parser.stream(frame);
  if (isResult(out)) { /* { ok:false, code:'SUMO_CAP_UNSUPPORTED' } — gate on can first */ continue; }
  for (const event of out) {
    // event: { type, payload, ext, id?, sessionId?, ts? } — ready for db.append once dedupe/source added
  }
}

new parsers['opencode']().file(rec);   // -> { ok:false, code:'SUMO_CAP_UNSUPPORTED' }  (no on-disk surface)
```

---

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | Public surface: `Parser`, `NormalizedEvent`, `KNOWN_TYPES`, the `parsers` registry. |
| `base/Parser.mjs` | Base class: `id`/`can`/`config`, capability gate, output validation, `ok`/`fail`/`isResult`. |
| `base/schema.mjs` | `NormalizedEvent` zod contract + `KNOWN_TYPES` + the passthrough guard. |
| `base/blocks.mjs` | Anthropic content-block normalizer, shared by Claude + Cursor. |
| `base/helpers.mjs` | `raw()` passthrough, per-event `idAt()`, `textOf()`, `tsMs()`. |
| `adapters/<harness>/index.mjs` | Per-harness `onStream`/`onFile` mapping. |

---

## Tests & fixtures

The conformance suite runs against **real captured transcripts**, not mocks — every harness-format
assertion uses a committed real payload (scrubbed value-level, shape preserved). See each
`test/fixtures/<harness>/PROVENANCE.md` for capture command, harness version, and scrub method.

```bash
node --test packages/transcript/test/contract.test.mjs packages/transcript/test/conformance.test.mjs
```

> `node --test packages/transcript/test` does **not** work — it treats the directory as a module. Pass
> the files (or run `pnpm test` for the whole repo).

**Live drift detector (runs by default).** Committed fixtures are real but frozen — they catch *our*
regressions, not a harness changing its format. The live suite re-runs the actual CLIs / app-server
and re-validates, so format drift breaks loudly. It runs live by default (no opt-in): it makes real
model calls when the relevant harness is available. Missing external CLIs/auth are reported as
node:test skips with explicit reasons, never mocked. Put the real harness binary on `PATH`, or use the
harness-owned environment variable when the harness provides one:

```bash
node --test packages/transcript/test/live.test.mjs
# if PATH `claude` is a wrapper shim that mangles --verbose, target the real binary:
CLAUDE_CODE_EXECPATH=/path/to/claude node --test packages/transcript/test/live.test.mjs
```

---

## Known limitations / deferred (for the next engineer)

- **Cross-source dedup of id-less events is unsolved** (Codex plain messages, Cursor messages). It
  needs a source-independent `position`, or `agent-artifacts` needs to skip already-seen records. The
  parser correctly omits `sessionId` on on-disk records (only Codex `session_meta` carries it);
  `agent-artifacts` attaches it via its recorded file-to-session correlation.
- **`session.plan` / `session.output` are not emitted** — no captured transcript construct produces
  them. Plan files are an `agent-artifacts` concern.
- **OpenCode `reasoning` parts and Codex `mcpToolCall`/`fileChange` items pass through**, not
  normalized — they are protocol-real but not yet fixture-covered; the live test exercises whatever the
  harness emits, and an un-mapped type passes through losslessly rather than being guessed.
- **Cursor `--stream-partial-output` is out of scope** — it emits partial frames with no reliable final
  marker; the canonical read surface is the non-partial stream (one final assistant frame).
