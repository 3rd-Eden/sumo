# 09 — `agent-artifacts` (acquisition + correlation)

## Scope: acquisition + correlation, NOT parsing or control

Per §3d, this package does the **I/O and bookkeeping** concern:
- **Acquire** artifacts from the filesystem/sources (tail live, import completed).
- **Parse** them by *delegating to the `jsonl` package* (`08`) — it does not parse itself.
- **Correlate** native sessions/artifacts back to Sumo session ids.

It does NOT parse transcript formats (that's `jsonl`) and does NOT control sessions (that's the
harness adapter). Those are separate focused packages it composes.

## What is acquired

| Artifact | Source | Handling |
|---|---|---|
| On-disk transcript | Claude/Codex/Cursor `.jsonl` files; OpenCode = none (live SSE only) | tail (live) or import (completed) → `jsonl.file()` → normalized `session.*` events |
| Plans | Cursor `.cursor/plans/*.plan.md`, Claude `~/.claude/plans/*.md` | watch/import → `plan.ingested`; link + summarize, index frontmatter |
| History | `~/.codex/history.jsonl` | index (cwd, command, ts) |
| Config snapshot | `config.toml`, `opencode.json`, `settings.json`, `.cursor/` | snapshot on session start (redacted, `16`) → `config.snapshot` |
| Exports | OpenCode export JSON, Claude JSONL | import → `jsonl.file()` normalized |
| Skill/plugin metadata | `.cursor/skills`, Claude/Codex plugins | index/link |

## Acquisition: live tail vs import

> **UPDATE (June 2026 — see "Always-on, project-scoped transcript ingestion"):** the live tail is
> now wired into the daemon as an always-on service (`ingest-service.mjs`), not just an on-demand API.
> It watches each tail-capable acquirer's `transcriptRoot()` and auto-consumes new transcripts of
> sessions Sumo did not stream — **bounded**: project-scoped (a Sumo-managed `sumo.yml` tree, not
> whole-machine), new-content-only (`ignoreInitial`) with a durable per-file watermark, and a
> service-owned foreign-doc policy (ambiguity/no-signal skip; mint one `observed` doc otherwise). The
> heuristic foreign-import correlation below is one INPUT to that policy, not the decider.

- **Live tail** — `chokidar`/`fs.watch` on appended JSONL (tail-`-f` semantics) for Claude/Codex/Cursor.
  OpenCode has no file → its live events come from the harness `Server` transport's SSE, NOT from
  here (this package handles OpenCode only for *exports*).
- **Import** — on demand for completed/closed sessions and exports.

Each acquired record is parsed via `jsonl` and handed to the daemon's idempotent append (`02`). The
on-disk transcript is the **second source** that the daemon dedups against the harness's **live
stream** (`05`): both normalize through the same `jsonl` parser, so the same logical turn produces the
same `dedupe` key and collapses (with richer fields merged). This package does not itself dedup — it
just appends; the daemon collapses.

## Correlation: matching disk artifacts → Sumo session ids (the novel seam)

A transcript file appears at `~/.claude/projects/<enc>/<uuid>.jsonl`. Which Sumo session produced it?

**Spawn-only scope () makes this mostly a recorded fact, not a guess.** Because Sumo launched the
session, it already knows the `cwd`, `pid`, spawn `timestamp`, and (once the harness reports it) the
native `session_id`. Correlation:

1. **Primary (recorded):** the harness adapter captures the native id from its live stream (Claude
   `system:init.session_id`, Codex rollout id, Cursor `result.session_id`) and the spawn `cwd`/`pid`/
   `ts`. The Sumo↔native mapping is written to the session document (`04`) at spawn/first-event — a
   fact, not a heuristic.
2. **Fallback (heuristic, for imports of sessions Sumo didn't spawn):** match on
   `cwd + transcript_path + pid + timestamp-window`. Used only for imported
   foreign transcripts, never for spawned sessions (spawn-only means primary path covers those).

```js
// correlation result written to the session doc
{ sumoId: 'ses_01J...', native: { id: '<uuid>', harness: 'claude-code' },
  transcriptPath: '~/.claude/projects/<enc>/<uuid>.jsonl', via: 'recorded' }   // or via:'heuristic'
```

## Retention

Normalized events follow the event-log TTL (`01`, default 90d); raw acquired artifacts follow the raw
TTL (default 14d); large plans/config are **linked + summarized**, not copied, and the summary is
durable. Redaction happens at storage time (`16`), not in this package or in `jsonl`.

## The package

```
packages/agent-artifacts/
  src/
    tail.mjs          # chokidar/fs.watch live tailing
    import.mjs        # completed-session / export import
    correlate.mjs     # native↔Sumo id mapping (recorded primary, heuristic fallback)
    snapshot.mjs      # config snapshot (delegates redaction to 16)
    index.mjs
  test/
    correlation.test.mjs   # spawned session: recorded mapping; foreign import: heuristic mapping
    dedup.test.mjs         # on-disk + live stream of same turn collapse to one seq (with jsonl + daemon)
```

## Conformance / acceptance

1. A spawned Claude session's on-disk transcript is correlated to its Sumo id via the **recorded**
   path (no heuristic needed).
2. The same logical turn, arriving from both the live stream (harness) and the on-disk tail (here),
   collapses to one event at the daemon (dedup), richer fields merged.
3. A Cursor `.plan.md` is ingested as `plan.ingested`, linked + summarized, frontmatter indexed.
4. OpenCode produces no on-disk transcript tail; its live events come from the harness transport, and
   only its export JSON is imported here.
5. A config snapshot is taken at session start with secrets redacted (`16`).

## Compatibility considerations

-   Tail mechanism: `chokidar` (robust, dep) vs raw `fs.watch` (no dep, platform
  quirks). Recommend `chokidar` for reliability across macOS/Linux.
-   Whether foreign-transcript import (the heuristic correlation path) is in 1.0 at
  all, given spawn-only scope — it may be deferred entirely until a "observe a session Sumo didn't
  spawn" feature is wanted. Recommend defer; keep the recorded path only for 1.0.
