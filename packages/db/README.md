# `sumo/db` — storage, daemon & event log

The foundational layer of Sumo: a single local daemon that owns the one LevelDB handle and acts as
the cross-process event hub. Everything above it (plugins, harness/messenger adapters, parser,
orchestrator, hooks) is a client of this layer — it is the only thing that touches the store.

Imported as `sumo/db`.

> **Scope.** This layer is storage + eventing only. It holds **no** workflow policy and **no**
> harness knowledge. Config resolution, the `sumo daemon` CLI, the parser, and the
> orchestrator live elsewhere and are out of scope here.

---

## Architecture

LevelDB allows only one process to open a database directory at a time. Rather than fight that, one
**daemon** is the sole opener; every other process is a client over a unix socket.

```
  client process ─┐
  (CLI/hook/MCP/  │   ~/.sumo/sumo.sock      ┌───────────────────────────────┐
   orchestrator)  ├── many-level reads ─────▶│  sumo daemon (sole DB owner)   │
                  │                          │   • classic-level handle        │
                  └── ~/.sumo/sumo-ctl.sock  │   • seq counter (meta:seq)      │
                      control channel ──────▶│   • subscriber registry         │
                      (put/del/append/       │   • minisearch index            │
                       subscribe/search)     │   • ttl sweeper                 │
                                             └───────────────────────────────┘
```

Two transports, by design:

- **KV reads (`get`/`scan`) ride [`many-level`](https://github.com/Level/many-level).** The package
  owns socket framing, iterator backpressure, and the LevelDB lock-race, so the client can read the
  ordered keyspace without custom framing.
- **Sumo-owned writes and event ops ride a thin control channel** (newline-delimited JSON, framed
  with `node:readline`). `put`/`del` need daemon-side serialization so TTL pointer cleanup and raw
  redaction cannot race the sweeper. `append`/`subscribe`/`search` carry Sumo event semantics, so
  they also live on this channel.

### Event delivery is wake-up + watermark (not payload-push)

On a new event the daemon broadcasts a **wake-up signal `{ sub, seq }`** — never the payload — to
filter-matching subscribers, *after* the write has committed. The client keeps a **watermark** and,
on each wake-up, reads `evt:` from `watermark→head` via the KV guest, filters client-side, and
advances the watermark. The initial backlog flush is the same read path.

Consequences: nothing to buffer for a slow subscriber but a seq number; a missed/coalesced wake-up
only costs latency (the next read catches up); and reconnection (when added) is the same watermark
read, not a special recovery path.

### Idempotent append = the enrichment mechanism

Every event carries a required **`dedupe`** key. The daemon keeps a `seen:<dedupe>` index. A
duplicate (same logical event arriving from a second, richer source — e.g. a harness's live stream
*and* its on-disk transcript) does **not** append a second event: it **enriches** the stored one,
filling gaps and deep-merging `ext`, never overwriting present values. This is both the dedup
guarantee and the multi-source enrichment mechanism.

---

## Usage

```js
import { openDb, newSessionId } from 'sumo/db';

const db = await openDb();              // auto-starts the daemon if none is running

// session document (schemaless value at ses:<id>)
const id = newSessionId();              // -> "ses_01J..."
await db.put(`ses:${id}`, {
  id, harness: 'claude-code', state: 'working',
  createdAt: Date.now(), updatedAt: Date.now()
});

// subscribe: backlog flush from `since`, then live; daemon-side filter by type/sessionId/source
const unsubscribe = await db.subscribe(
  { since: 0, filter: { type: ['session.message'] } },
  (event) => console.log(event.seq, event.type, event.payload)
);

// append an event (idempotent on `dedupe`); returns the assigned seq
await db.append({
  dedupe: 'uuid:abc-123',               // source natural id, or a content hash (see dedupe.mjs)
  type: 'session.message',
  sessionId: id,
  source: 'session',
  payload: { text: 'hello' }
});

// raw artifact with a 14-day TTL (redacted before storage; sweeper deletes it + its pointer)
await db.put(`raw:${id}:0000000001`, { command: 'OPENAI_API_KEY=sk-… node task.mjs' }, {
  ttlMs: 14 * 24 * 60 * 60 * 1000
});

const hits = await db.search('retry backoff');   // [{ docref, score }]

await db.close();
unsubscribe();                          // (or call before close)
```

### `SumoDb` API

| Method | Notes |
|---|---|
| `get(key)` | `undefined` if absent (never throws on missing). |
| `put(key, value, { ttlMs? })` | Serialized by the daemon; removes stale TTL pointers first. `raw:` values are redacted before storage. |
| `del(key)` | Serialized by the daemon; removes stale TTL pointers. |
| `scan(prefix, { limit?, reverse? })` | `AsyncIterable<[key, value]>`, ordered. |
| `append(event)` | Idempotent on `event.dedupe`; returns the assigned `seq`. |
| `subscribe({ since?, filter? }, handler)` | Returns an `unsubscribe()` fn. Backlog-then-live; lossless via watermark. |
| `search(query, { limit? })` | Full-text over event payload text; `[{ docref, score }]`. |
| `close()` | |

`event` for `append` must carry `dedupe` and `type`; `sessionId`/`source`/`adapter`/`payload`/`ext`/
`ts`/`rawRef`/`redactions` are optional. The daemon assigns `seq` and stamps `ts` if absent. The full
contracts are in [`src/schema.mjs`](src/schema.mjs) (zod is the source of truth; JSDoc mirrors it).

---

## Keyspace

Keys are byte-ordered; structure is encoded into the keyspace so range scans serve as indexes.
Fixed-width zero-padded numeric segments make lexical order equal numeric order. See
[`src/keyspace.mjs`](src/keyspace.mjs).

```
meta:seq                       last assigned event seq (integer)
meta:version                   storage format version
ses:<sessionid>                session document
evt:<seq20>                    append-only event log (seq20 = 20-digit zero-padded)
seen:<dedupe>                   idempotency index -> seq of the stored event
txn:<sessionid>:<idx10>        normalized transcript event
raw:<sessionid>:<idx10>        raw adapter artifact (TTL-swept)
claim:<adapter>:<workid>       coordination mirror (adapter remains source of truth)
kv:<plugin>:<ns>:<key>         plugin namespaced storage
idx:fts:<term>:<docref>        (reserved) inverted-index postings
ttl:<expiresAt13>:<targetKey>  TTL sweep pointer
```

---

## Lifecycle

- **Auto-start.** `openDb()` probes the socket; if absent it spawns the daemon detached and waits.
  `SUMO_NO_AUTOSTART=1` (or `openDb({ autostart: false })`) turns this into a clear `SUMO_NO_DAEMON`
  error instead of spawning.
- **Lock-race is safe.** Two daemons spawning at once: the OS LevelDB lock lets one win; the loser
  exits with `SUMO_DB_LOCKED` and the client connects to the winner.
- **Idle-shutdown.** Default 30 min with zero connected clients; configurable via `idleShutdownMs`
  (`0` disables) or `SUMO_IDLE_MS`.
- **Crash recovery.** On restart the daemon recovers `seq` from `meta:seq` (or the last `evt:` key),
  unlinks stale sockets, and rebuilds the search index from the log. Durable state is intact;
  clients reattach and resume from their watermark, losing no events.

## Security

Owner-only by construction: the home dir (`~/.sumo`, or `$SUMO_HOME`) is `0700`; the two sockets and
the pidfile are `0600`. Failure to apply `0600` is a **hard** `SUMO_INSECURE_PERMS` error — never
silently swallowed. No network listener.

Writes to `raw:` keys pass through a conservative storage-time redactor before persistence. It
redacts common secret-bearing key names and token-like string patterns. This package enforces the
storage boundary; callers should still avoid writing secrets when they can.

## Errors

`SumoError` subclasses carry a stable `code` mapping to the `SumoDiagnostic` model:
`SUMO_DB_LOCKED`, `SUMO_NO_DAEMON`, `SUMO_BAD_MESSAGE`, `SUMO_BAD_OP`, `SUMO_INSECURE_PERMS`,
`SUMO_INTERNAL`. Operational failures return/throw these; programmer errors throw plain `Error`.

---

## Development

```bash
pnpm install                              # install dependencies
pnpm test                                 # full suite (node:test), incl. the tsc type-check test
pnpm run types                            # type-check JSDoc + emit .d.mts to types/ (gitignored)
node --test packages/db/test/eventlog.test.mjs   # one file
```

> Use `pnpm test` (or a file glob). `node --test packages/db/` does **not** work — it treats the
> directory as a module.

**Type checking.** Source is plain `.mjs` (no transpile step). `tsconfig.json` runs `tsc` over the
JSDoc with `checkJs` + `strict` and emits declaration files only — `packages/db/test/types.test.mjs`
runs the real compiler in the suite, so wrong JSDoc fails CI.

### Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | Public surface: `openDb`, `newSessionId`, `SumoError`. |
| `client.mjs` | `SumoDb`: KV via the guest, custom ops via the control channel, auto-start. |
| `daemon/host.mjs` | The daemon: `ManyLevelHost` + control server + subscriber registry + lifecycle. |
| `daemon/main.mjs` | Detached entrypoint the client spawns. |
| `eventlog.mjs` | Transport-free `evt:<seq>` append/dedupe-merge/`recoverSeq`/`backlog`; `matchesFilter`. |
| `dedupe.mjs` | `dedupe` derivation + the fill-gaps-never-overwrite / `ext`-deep-merge rule. |
| `schema.mjs` | zod contracts (event, session, control messages) + `ses_<ulid>` ids. |
| `keyspace.mjs` | Key encoders and range helpers. |
| `search.mjs` | In-memory `minisearch`, rebuilt from `evt:` on start. |
| `sweeper.mjs` | TTL sweeper (`ttl:` scan → delete → `ttl.swept`). |
| `redaction.mjs` | Minimal storage-time redaction for `raw:` records. |
| `paths.mjs` | `~/.sumo` layout + `0700`/`0600` enforcement. |
| `errors.mjs` | `SumoError` + lock-error detection. |

---

## Implementation Choices

- **`many-level` for keyspace reads** plus a Sumo control channel for writes/event operations.
- **Wake-up + watermark delivery**, not payload-push.
- **Backend `classic-level`**, pinned to the **`abstract-level@1` generation** because `many-level@2`
  requires it (one major behind `classic-level@3`; isolated behind this layer).
- **One global daemon + DB at `~/.sumo`**, scoped by project. 30-min idle default.

The owning specification still wins if these implementation choices need to change; daemon scope and
idle-shutdown defaults are not globally settled architecture decisions yet.

## Operational Boundaries

- **Reconnect is caller-driven.** A connected client keeps the daemon alive, so the normal loss case
  is a daemon crash mid-connection. Persist the last-seen `seq` and call `subscribe({ since })` after
  reopening; the existing watermark path provides lossless recovery.
- **Filtered subscribers still read the full range.** Daemon-side filtering governs *which wake-ups*
  a subscriber gets (the efficiency win), but on a wake the client reads the whole `evt:` range from
  its watermark and re-filters client-side.
- **Search indexes events only** (`evt:` payload text), not session docs; held in memory and rebuilt
  on start. Incremental `idx:fts:` persistence is not implemented.
- **No per-request `cwd`.** DB path selection is process/config scoped.
- **Redaction policy is minimal.** `raw:` values are redacted for common token shapes before storage.
- **Node floor.** `engines` is `>=22`.
- **Backend choice.** `classic-level` is the supported backend for this package.
