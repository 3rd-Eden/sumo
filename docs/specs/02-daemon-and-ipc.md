# 02 — Daemon & IPC

> The daemon is the mechanism that makes the storage layer (`01-storage-and-eventing.md`) able
> to deliver cross-process events at all. It is **not optional**: cross-process eventing is a
> hard requirement, and a single DB-owning process is the architecturally honest way to
> guarantee it with an embedded KV store that permits only one writer.

## Reuse `many-level` / `level-party`? (STEER — evaluate before hand-rolling)

Verified finding: the Level org ships two packages that already solve "multiple processes, one
LevelDB" — the exact problem the daemon exists for.

- **`level-party`** — "Open a leveldb handle multiple times, transparently upgrading to use
  multileveldown when more than 1 process tries to use the same leveldb data directory at once, and
  re-electing a new master when the primary unix socket goes down." This is *literally* the
  daemon-as-sole-owner pattern with automatic leader election over a unix socket — including the
  failover case this spec did not address.
- **`many-level`** — host/guest split: `ManyLevelHost` exposes a DB (or a sublevel) over a stream;
  `ManyLevelGuest` extends `AbstractLevel`, so guests use the full standard API
  (`get`/`put`/`iterator`/`sublevel`/`seek`) transparently. Verified properties: iterators have
  **built-in end-to-end backpressure** regardless of transport (this resolves the
  `` backpressure question), and a `retry` option resends operations on reconnect.

**Recommendation :** prototype the daemon on `level-party` (auto leader election, no
manual master/lifecycle code) or `many-level` (explicit host/guest, more control). This likely
replaces the bespoke socket framing, master lifecycle, and backpressure handling described below.

**The catch the daemon still must add on top:** `many-level`/`level-party` proxy *storage
operations* (get/put/iterator). They do **not** by themselves provide the **event stream** (the
`evt:<seq>` broadcast). So even if Sumo adopts them for the KV transport, the daemon still owns:
(a) assigning the monotonic `seq`, and (b) broadcasting new-event wake-ups to subscribers. The
event layer sits *above* the level-proxy, not inside it. So the realistic architecture is:
**`level-party`/`many-level` for the shared-DB transport + a thin Sumo event-broadcast channel on
top**, rather than a fully hand-rolled daemon. The hand-rolled protocol below remains the
fallback/reference if neither package fits.

>   Adopt `level-party` (simplest, auto-failover) vs `many-level` (explicit
> host/guest, finer control) vs hand-rolled (full control, more code). Recommend evaluating
> `level-party` first.

## What the daemon is (and is not)

- **It is** a small, local, single-user background process that owns the one LevelDB handle and
  acts as the event hub and storage RPC server over a unix-domain socket. It is the same *shape*
  as `tmux`, `gpg-agent`, or the Docker daemon — a local helper process, started on demand.
- **It is NOT** a hosted/cloud control plane. The brief forbids a *hosted cloud* control plane;
  a local single-user daemon over a unix socket does not violate that. This distinction is
  deliberate.

## Responsibilities (narrow and fixed)

1. **Own the single LevelDB handle.** All reads/writes from all surfaces go through it.
2. **Assign the monotonic `seq`.** Sole writer ⇒ no coordination needed; `seq` persisted as
   `meta:seq`, recovered on startup from the last `evt:` key.
3. **Append events idempotently — this IS the enrichment/completion mechanism.** On each observable
 write the daemon checks the event's required `dedupe` key against the `seen:<dedupe>` index (§01).
 **If unseen:** append `evt:<seq>`, record `seen:<dedupe> → seq`, push `{ seq }` to subscribers
 (in-daemon consumers get it directly). **If already seen:** do NOT append a new event; **enrich**
 the stored event by merging fields the duplicate carries that the stored one lacked, then return
 the existing `seq`.

 **Why this is where enrichment lives:** the four harnesses differ in *completeness*, not just
 format — the same logical event can arrive from two sources with different richness (Claude's live
 stream lacks the `parentUuid`/summary the on-disk `.jsonl` has; Cursor's transcript omits some tool
 outputs the live stream carried; OpenCode's SSE may hold a result its absent file cannot). Each
 source is normalized **independently** by its parser (§08); the daemon is the **only point both
 normalized copies converge**, so completion-from-a-richer-source can only happen here. This is the
 brief's "enrich the common model from multiple verified sources," realized as a merge at the sole
 writer.

 **Merge rule (fill-missing semantics, §3b):** for the same `dedupe` key, **fill gaps, do not overwrite
 present values.** A field absent on the stored event and present on the duplicate is **merged in**;
 a field present on both is **left as-is** (first-writer wins for normalized fields — they should be
 equal anyway if both parsers target the §07 vocabulary correctly); `ext` sub-objects **deep-merge**
 (each source contributes its harness-specific keys). The daemon never replaces a present normalized
 value from a duplicate — divergence there is a parser bug the conformance suite (§08) catches, not
 something to silently resolve. The sole-writer daemon is the natural, race-free chokepoint .

 This handles **missing-but-recoverable** data (the event exists in another source, richer).
 **Missing-and-unrecoverable** data — a field a harness simply never produces (e.g. token-usage on a
 harness that doesn't report it) — is NOT a merge problem and is handled by absence + `can`, see §07.
4. **Serve storage RPC** (`get`/`put`/`del`/`scan`/`append`/`search`) over the socket.
5. **Maintain the search index** (`idx:fts:`, via `minisearch`).
6. **Run the TTL sweeper** (`ttl:` scan, §01).
7. **Lifecycle**: pidfile, socket creation/cleanup, optional idle-shutdown, crash recovery.

The daemon contains NO workflow policy and NO harness knowledge. It is storage + eventing only.
Orchestration may run *inside* the daemon process (long-running) or in a separate client process
— that is the orchestrator's choice (`10-orchestrator.md`), not the daemon's concern.

## Topology

```
   CLI invocation ─┐
   hook script   ──┤   unix domain socket          ┌───────────────────────────────┐
   MCP server    ──┼──  ~/.sumo/sumo.sock (0600) ──▶│  sumo daemon (sole DB owner)   │
   orchestrator  ──┘   req/resp + event stream      │   • LevelDB handle              │
                                                     │   • seq counter (meta:seq)      │
                                                     │   • subscriber registry         │
                                                     │   • minisearch index            │
                                                     │   • ttl sweeper                 │
                                                     └───────────────────────────────┘
```

Clients never open LevelDB. The client library (`sumo/db`) exposes the `SumoDb` API (§01) and
transparently performs socket RPC. A plugin or capability cannot tell whether it is running
inside the daemon process or a separate one — the API is identical. This keeps "all interfaces
share one runtime" true.

## Wire protocol

- **Transport:** unix domain socket at `$SUMO_HOME/sumo.sock` (default
  `~/.sumo/sumo.sock`), mode `0600`.
- **Framing:** **newline-delimited JSON (JSONL)** — one JSON object per line.
  Trivial in `.mjs`, no schema compiler, matches the rest of the stack. Alternative considered:
  length-prefixed MessagePack (faster, heavier) — not justified for local single-user 1.0.
- Every message is validated by a zod schema (`CONVENTIONS.md` §3) on receipt.

### Message types

Request/response (correlated by `id`):

```json
{ "id": "1", "op": "get", "key": "ses:ses_01J..." }
{ "id": "1", "ok": true, "value": { "...": "..." } }

{ "id": "2", "op": "put", "key": "ses:...", "value": { }, "ttlMs": null }
{ "id": "2", "ok": true }

{ "id": "3", "op": "append", "event": { "type": "tool.pre", "dedupe": "uuid:abc-123", "...": "..." } }
{ "id": "3", "ok": true, "seq": 10231, "deduped": false }   // deduped:true + same seq if already seen

{ "id": "4", "op": "scan", "prefix": "txn:ses_01J...:", "limit": 500 }
{ "id": "4", "ok": true, "entries": [ ["txn:...:0000000001", { } ] ] }

{ "id": "5", "op": "search", "query": "retry backoff", "limit": 20 }
{ "id": "5", "ok": true, "hits": [ { "docref": "...", "score": 3.2 } ] }
```

Subscription (server-push; `since` makes it resumable):

```json
{ "id": "6", "op": "subscribe", "since": 10200, "filter": { "type": ["tool.pre","tool.post"] } }
{ "id": "6", "ok": true }                         // subscription accepted
{ "sub": "6", "event": { "seq": 10201, "...": "" } }   // backlog flush (since→now), in order
{ "sub": "6", "event": { "seq": 10231, "...": "" } }   // then live
{ "id": "6", "op": "unsubscribe" }
```

Errors carry a stable code mapping to `SumoDiagnostic`:

```json
{ "id": "2", "ok": false, "error": { "code": "SUMO_DB_LOCKED", "message": "..." } }
```

## Subscription semantics

- On `subscribe`, the daemon **first flushes the backlog** by range-scanning `evt:` from
  `since+1` to the current head, emitting in `seq` order, **then** attaches the client to the
  live broadcast. This guarantees a late or reconnecting subscriber misses nothing.
- Filtering is applied **daemon-side** before push (by `type`, `sessionId`, `source`).
- The watermark is the client's responsibility to persist if it needs durability across its own
  restarts; the daemon does not track per-client watermarks beyond the live connection.

## Lifecycle

**Auto-start with idle-shutdown (default), with an explicit override.**

- **Auto-start:** the first `sumo` invocation that needs the store checks for a live socket; if
  absent, it spawns the daemon (detached, own process group), waits for the socket to accept,
  then proceeds. A lockfile prevents two simultaneous spawns racing.
- **Pidfile + socket:** `~/.sumo/sumo.pid`, `~/.sumo/sumo.sock`. On startup the daemon checks for
  a stale socket/pid (process dead) and cleans up.
- **Idle-shutdown:** after N minutes (default 30, configurable; `0` disables) with zero connected
  clients and no active sessions/subscriptions, the daemon exits cleanly, closing LevelDB.
- **Explicit control:** `sumo daemon start|stop|status|restart` for users who want to manage it
  (e.g. long-running orchestration, debugging). `SUMO_NO_AUTOSTART=1` disables auto-spawn (then
  a missing daemon is a clear error with remedy, not a silent start).
- **Crash recovery:** on restart the daemon recovers `seq` from `meta:seq` / last `evt:` key and
  resumes. Durable state is intact (LevelDB); only live subscriptions are lost and clients
  re-subscribe with their watermark, losing no events.
- **Single-writer safety:** LevelDB's own directory lock guarantees only one daemon can own the
  store; a second daemon spawn fails fast with `SUMO_DB_LOCKED` and the client connects to the
  existing one instead.

## Security

- Socket mode `0600`, directory `0700` — owner-only. (See §12; this also addresses the
  researched concern about world-readable artifacts.)
- The daemon performs **redaction on raw payloads before persistence** (§12), so secrets are not
  written to disk even transiently in the `raw:` layer beyond what redaction allows.
- No network listener in 1.0. (A future remote/team mode would be a separate, opt-in transport,
  explicitly out of 1.0 identity.)

## Compatibility considerations

- **Idle-shutdown default** (30 min) vs never — depends on how persistent users
  expect orchestration state to be between invocations.
-   Slow-subscriber backpressure: `many-level` iterators provide
  built-in end-to-end backpressure regardless of transport, and `retry` resends on reconnect. If
  Sumo adopts it for the KV transport, the storage-op backpressure question is answered by the
  package. The *event broadcast* channel layered on top still needs its own policy — recommend
  lossless drop-and-recatch via the `seq` watermark (a dropped wake-up only costs latency).
- **Multiple projects / multiple daemons:** one daemon per `~/.sumo` (global) vs
  one per project root. Recommend one global daemon scoping by project; revisit if isolation is
  needed.
