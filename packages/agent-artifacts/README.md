# `sumo/agent-artifacts` — on-disk acquisition + correlation

The **on-disk source**. It acquires harness artifacts from the filesystem — tails live transcripts,
imports completed ones and exports, and ingests plans/config — then **delegates parsing to
[`sumo/transcript`](../transcript)** and appends the normalized events to the daemon
([`sumo/db`](../db)). It also correlates a native transcript back to the Sumo session id that produced
it.

Imported as `sumo/agent-artifacts`.

> **Scope.** Acquisition + correlation only — the **I/O and bookkeeping** concern. It is a pure
> **sensor**: it acquires and appends, nothing more. It does **not** parse transcript formats
> (that is `sumo/transcript`) and does **not** dedupe or merge events (the daemon does that at append
> time). If this layer finds itself parsing a format or merging events, it has crossed a
> boundary. It is the **second source** whose events collapse against the harness layer's live stream
> at the daemon's `dedupe`.

---

## Why it computes the same dedupe key as the live source

The architectural payoff: one logical turn arriving from **both** the harness live stream
(`source:'session'`) **and** this layer's on-disk tail (`source:'transcript'`) must collapse to one
event. The daemon collapses by `dedupe` key, so both sources MUST derive that key identically. To make
that true *by construction* (not by luck), the key derivation lives once in
[`sumo/db/dedupe`](../db/src/dedupe.mjs) — `dedupePrefix(type)` + `eventDedupe(evt, { sessionId,
position })` — and **both** the harness base (`Harness.toEvent`) and this layer (`Acquirer.#toInput`)
call it. `source` differs so provenance stays visible; the key collapses the pair regardless.

Collapse only happens for events that carry a **shared natural id**. What actually collapses, verified
from real captures:

| harness | collapses on | id-less → no collapse |
|---|---|---|
| `claude-code` | `msg:<message.id>#<blockIndex>` (text/reasoning), `call:<tool_use.id>` (tools) | — |
| `copilot` | `msg:<messageId>` (assistant messages), `call:<toolCallId>` (tools) | **idle/system/hook/plan markers** (no shared natural id) |
| `codex` | `call:<call_id>` (tools) | **plain messages/reasoning** (file records carry no `item.id`) |
| `cursor` | — | **everything** (no id either surface; on-disk text is query-wrapped → `divergent`) |
| `opencode` | n/a | no harness adapter exists → no live source → no cross-source pair |

Id-less events content-hash with a per-source monotonic `position`, so they do **not** collapse across
sources — by design, asserted honestly in the tests rather than faked. Closing Codex/Cursor
cross-source dedup is still unsolved.

---

## The contract

An acquirer **is an adapter**: a class extending `Acquirer`, declaring `id` / `can` / `config` as
instance props, covered by one parametrized conformance suite. Sensor-only — there is no `write`.

```js
import { Acquirer } from 'sumo/agent-artifacts';

export class ClaudeArtifacts extends Acquirer {
  id  = 'claude-code';
  can = { tail: true, import: true };   // which acquisition modes exist
  configFiles = ['~/.claude/settings.json'];
  // entry getter derives 'file' | 'stream' from the parser's `can`; signals() extracts correlation hints
}
```

- **`import(records, { db, sessionId })`** — parse every record via the delegated parser, append the
  normalized events (`source:'transcript'`), emit one `transcript.ingested`. Returns an
  `AcquireSummary` Result.
- **`tail(path, { db, sessionId, signal, fromStart })`** — live tail (chokidar polling); each appended
  line is parsed and its events appended as they arrive. Capability-gated on `can.tail`: OpenCode (no
  on-disk JSONL) returns `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }`; it does not throw or fake support.
- **`entry`** — which parser entry point feeds on-disk records: `.file()` for Claude/Codex/Cursor,
  `.stream()` for OpenCode (its parser is `file:false`; an export is replayed SSE-shaped records).

### Correlation — `correlate(db, { harness, transcriptPath, signals })`

For Sumo-spawned sessions, the native-to-Sumo mapping is a **recorded fact** on the session document
(`ses:<id>`). This module is a pure **reader** of those docs; it never writes them.

- **Recorded (primary)** — match the artifact's `harnessSessionId` / `transcriptPath`, **scoped to the
  same `harness`** (a Codex import never matches a same-cwd Claude session). `via:'recorded'`.
- **Heuristic (foreign imports only)** — for transcripts Sumo didn't spawn: match a `harness`-scoped
  session doc with no recorded native id by `cwd`/`project` within the transcript's time window.
  Exactly one → `via:'heuristic'`; zero/ambiguous → a diagnostic (`SUMO_CAP_UNSUPPORTED` /
  `SUMO_AMBIGUOUS`), never a guess. Signals are extracted **per-harness** (`adapter.signals(...)`):
  Claude/Codex from in-record `cwd`/id/`timestamp`; Cursor from the transcript **path** (its records
  carry none).

> **Spawn-time spine.** `Harness.run()` writes a `ses:` document before the first prompt and records
> the native `harnessSessionId` / `transcriptPath` when the transport exposes them. That makes
> recorded correlation the primary live path for Sumo-spawned sessions; heuristic correlation is only
> for foreign transcripts.

### Artifact events

- **`transcript.ingested`** `{ count }` — emitted by `import` after a batch.
- **`plan.ingested`** `{ planRef, summary }` — plans are **linked + summarized, not copied**. Cursor
  `.cursor/plans/*.plan.md` → YAML frontmatter (`name`/`overview`/`todos[].{id,status}`/`isProject`);
  Claude `~/.claude/plans/*.md` → `#` title + `##` headings. `overview` is length-bounded (the event
  payload is not redacted).
- **`config.snapshot`** `{ rawRef, redacted:true }` — the config is stored under a `raw:` key (which
  the daemon redacts on write) and the event carries only a reference + flag. **No config content, no
  secret, in the event.** JSON configs are stored structured so key-based redaction applies; TOML/JSONC
  fall back to string (token-pattern) redaction.

---

## Usage

```js
import { acquirers, correlate, ingestPlan, snapshotConfig } from 'sumo/agent-artifacts';

const a = new acquirers['claude-code']();            // registry keyed by harness id

// Correlate the transcript to a Sumo session, then import it (correlate → attach sessionId → dedupe).
const c = await correlate(db, { harness: 'claude-code', transcriptPath, signals: a.signals({ records }) });
const sessionId = c.ok ? c.value.sumoId : undefined;
await a.import(records, { db, sessionId });

// Live tail (Claude/Codex/Cursor); OpenCode tail() → SUMO_CAP_UNSUPPORTED.
const t = a.tail(transcriptPath, { db, sessionId, signal });
if (t.ok) { /* t.value.stop() to stop; await t.value.ready for the initial read */ }

await ingestPlan(db, { path: planPath, harness: 'cursor', sessionId });
await snapshotConfig(db, { harness: 'codex', sessionId, path: '~/.codex/config.toml' });
```

---

## The five harnesses

| harness | transcript path | entry | modes | plans | `transcriptComplete` |
|---|---|---|---|---|---|
| `claude-code` | `~/.claude/projects/<enc>/<uuid>.jsonl` | `file` | tail + import | `~/.claude/plans/*.md` | `true` |
| `copilot` | `$COPILOT_HOME/session-state/<sessionId>/events.jsonl` else `~/.copilot/session-state/<sessionId>/events.jsonl` | `file` | tail + import | sibling `plan.md` | `true` |
| `codex` | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` | `file` | tail + import | — | `true` |
| `cursor` | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `file` | tail + import | `.cursor/plans/*.plan.md` | **`false`** |
| `opencode` | none (SQLite store) | `stream` | **import only** | — | `true` |

---

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | Public surface: `Acquirer`, the `acquirers` registry, `correlate`, `ingestPlan`/`summarizePlan`, `snapshotConfig`, `tailFile`, Result/schema exports. |
| `base/Acquirer.mjs` | Base: `import`/`tail`, the append-with-dedupe path (`eventDedupe` + `source:'transcript'`), parser composition. |
| `base/schema.mjs` | zod contracts (`Correlation`, `AcquireSummary`, `ArtifactRef`) + `ok`/`fail`/`isResult`. |
| `tail.mjs` | chokidar **polling** tailer: byte-offset tracking, partial-line buffering, incremental UTF-8 decoding. |
| `correlate.mjs` | Recorded + heuristic native↔Sumo mapping (reader of `ses:` docs). |
| `plan.mjs` | Plan summarize/ingest (frontmatter via `yaml`, or markdown headings). |
| `snapshot.mjs` | Redacted config snapshot (structured `raw:` blob + `config.snapshot` event). |
| `adapters/<harness>/index.mjs` | Per-harness paths, `can`, `configFiles`, correlation `signals()`. |

---

## Tests & fixtures

The tests reuse the real on-disk captures committed under
[`packages/transcript/test/fixtures/`](../transcript/test/fixtures) and add only the artifact kinds
this package owns, such as plans and config snapshots. See
[`test/fixtures/PROVENANCE.md`](./test/fixtures/PROVENANCE.md).
The real-daemon tests spin up an actual `sumo/db` daemon on a temp home (no mocks).

```bash
node --test packages/agent-artifacts/test/*.test.mjs
```

> `node --test packages/agent-artifacts/test` does **not** work — pass the glob (or run `pnpm test`).

What the suite proves: the `can` matrix + capability gating; import normalizes/appends/validates and
tags `source`/`adapter`; the **cross-source collapse to one seq with merged `ext`** (Claude, Copilot,
and Codex tool) against a real daemon, Cursor staying two seqs (`divergent`), OpenCode N/A; the tailer's ordering,
partial-line, and split-multibyte-UTF-8 handling against a real appended file; harness-scoped recorded +
heuristic correlation (incl. the same-cwd mis-attribution guard and the ambiguity diagnostic); plan
summarize (linked, not copied); and per-harness config redaction (token-shaped **and** opaque-keyed
secrets) at the `raw:` boundary.

---

## Known limitations / deferred (for the next engineer)

- **Foreign observed-session import remains conservative.** Sumo-spawned sessions now write the
  `ses:` correlation spine, including native ids and transcript paths when the transport exposes
  them. Foreign sessions still rely on heuristic signals and ambiguity checks.
- **Cross-source dedup of id-less events is unsolved** (Codex plain messages, Cursor) and inherited
  from `sumo/transcript`. This layer does not fake a collapse that the keys do not produce.
- **OpenCode export shape is unverified.** `.stream()` replay is proven only for SSE-shaped records; no
  real `opencode export` payload has been captured. Flagged as a capture gap, not claimed as supported.
- **OpenCode exports use `.stream()`.** OpenCode's parser has no file surface (`file:false`), so the
  importer replays export records through `.stream()`.
- **Tailer scope:** append-only, one file per session — log **rotation** (a replaced file re-grown past
  the old offset before the next poll) is out of scope; only truncation is handled. A malformed
  (non-JSON) line is skipped, not surfaced as passthrough (it is byte corruption, not a parser record).
- **Redaction strength is the daemon's:** `sumo/db`'s redactor is deliberately minimal, so opaque-keyed
  secrets in **TOML** string values are not caught yet.
