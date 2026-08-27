# 01 — Storage & Eventing

> Read alongside
> `02-daemon-and-ipc.md` (the daemon is the mechanism that makes cross-process events work, and
> documents the verified `many-level`/`level-party` packages that may replace hand-rolled IPC) and
> `CONVENTIONS.md` (`.mjs`, zod, adapters).

## Decision summary

- **Store: `classic-level` (LevelDB) via the `abstract-level` family.** A
  schemaless, ordered key-value store, embedded, open source, trivial `npm install`, pure
  ordered-key semantics with streaming range iterators.
- **Why NoSQL/KV, not SQL:** harness artifacts (transcripts, plans, hook
  payloads, exports) evolve unpredictably across versions. A fixed relational schema would force
  continuous migrations. A schemaless KV store lets adapters write whatever shape they produce
  and lets Sumo normalize at read time. This is the "common and extensible" principle expressed
  directly in the data layer.
- **The database is owned by a single local Sumo daemon.** LevelDB allows
  only one process to open a directory at a time; rather than fight that, the daemon is the sole
  opener. Every other surface (CLI, hooks, MCP, orchestrator) is a client of the daemon. See
  `02-daemon-and-ipc.md`.
- **Events are an append-only log in the keyspace; delivery is daemon broadcast +
  resumable `seq` watermark.** Because the daemon is the only writer, it sees every write and
  emits an event for each — there is no cross-process notification problem to solve, because no
  other process touches the store.
- **Backend choice within `abstract-level`: `classic-level` (LevelDB) for 1.0.**
  Swap to `rocksdb`-backed (`rocksdb` via `abstract-level`) only if event/write volume becomes a
  bottleneck — the swap is isolated behind the daemon's storage module. `memory-level` is used
  in tests.

## The store is schemaless; the keyspace is the index

LevelDB keys are byte-ordered. Sumo encodes structure into the keyspace so that range scans
serve as indexes. All values are JSON (UTF-8 encoded). There is no schema enforced by the store;
zod validates the *normalized* shapes at read/write boundaries in core, while *raw* adapter
documents are stored verbatim.

### Keyspace layout

```
meta:seq                          -> last assigned event seq (integer, persisted)
meta:version                      -> storage format version

ses:<sessionid>                   -> session document (schemaless JSON)
evt:<seq20>                       -> event document (append-only log; seq20 = zero-padded 20-digit)
seen:<dedupe>                     -> seq of the already-stored event with this dedupe key (idempotency index)
txn:<sessionid>:<idx10>           -> normalized transcript event
raw:<sessionid>:<idx10>           -> raw adapter artifact, verbatim (TTL-swept)
claim:<adapter>:<workid>          -> coordination mirror (source of truth is the adapter, see §8)
kv:<plugin>:<ns>:<key>            -> plugin namespaced storage
idx:fts:<term>:<docref>           -> inverted-index posting (knowledge/dependency search)
ttl:<expiresAt13>:<key>           -> TTL sweep index (expiresAt13 = zero-padded epoch-ms)
```

- `seq20` and `idx10` and `expiresAt13` are **zero-padded fixed-width** so lexical key order
  equals numeric order. This is what makes "all events since N" a single range scan.
- **Sublevels** (from `abstract-level`) partition the keyspace cleanly. Each plugin gets its own
  sublevel (`kv:<plugin>`) which both namespaces storage and enforces the trust boundary from
  §12 (a plugin's `db` handle is opened on its own sublevel and cannot address another plugin's
  keys).

### Range-scan "indexes"

| Query | Implementation |
|---|---|
| All events since `seq` | range scan `evt:` from `evt:<seq+1>` (resumable watermark) |
| All transcript events for a session | prefix scan `txn:<sessionid>:` |
| All raw artifacts for a session | prefix scan `raw:<sessionid>:` |
| All of a plugin's storage | prefix scan `kv:<plugin>:` (or open the sublevel) |
| Expired records to sweep | prefix scan `ttl:` up to `ttl:<now>` |
| Full-text search | scan `idx:fts:<term>:` (index maintained by the daemon, see "Search") |

## Documents: normalized layer + raw layer + `ext` bag

Three layers coexist so that harness evolution never breaks a consumer:

1. **Raw** (`raw:`) — the adapter's artifact written verbatim. Never read by plugins directly;
   short TTL; redacted before storage (§12). This is the audit/evidence layer.
2. **Normalized** (`ses:`, `txn:`, `evt:`) — the common Sumo shapes, validated by zod. This is
   what plugins consume.
3. **`ext` bag** — every normalized JSON value carries an `ext` object holding adapter-specific
   fields that have no common-model home. Adding a new harness field means adding a key inside
   `ext` that nobody is forced to read — not a schema migration.

Example session document (schemaless value at `ses:<id>`):

```json
{
  "id": "ses_01J...",
  "harness": "claude-code",
  "harnessSessionId": "abc123",
  "cwd": "/work/proj",
  "pid": 41234,
  "state": "working",
  "createdAt": 1718800000000,
  "updatedAt": 1718800050000,
  "transcriptPath": "/home/example/.claude/projects/<hash>/abc123.jsonl",
  "ext": { "model": "claude-opus-4-8", "permissionMode": "default" }
}
```

## Event log & delivery

### The event document (`evt:<seq>`)

```json
{
  "seq": 10231,
  "ts": 1718800050000,
  "sessionId": "ses_01J...",
  "source": "hook|transcript|orchestrator|messenger|plugin|session",
  "type": "tool.pre",
  "adapter": "claude-code",
  "dedupe": "uuid:abc-123",
  "payload": { "...normalized fields..." },
  "rawRef": "raw:ses_01J...:0007",
  "redactions": [ { "offset": 42, "len": 40, "kind": "token" } ]
}
```

The event carries normalized `payload`; the bulky/raw original is stored separately under `raw:`
and referenced by `rawRef` so the log stays compact and the raw layer can be TTL-swept
independently.

**`dedupe` is a REQUIRED key** preventing the same logical event from being stored twice when it
arrives from two sources (e.g. a harness's live stream AND its on-disk transcript — see
`05-harness-api.md`). It is either the artifact's natural id (`uuid:...`, prefixed by source) or, when
none exists, a content hash of `(sessionId, kind, normalized-payload, monotonic-position)`. The
position component keeps genuinely-distinct-but-identical events (the agent says "ok" twice) from
collapsing. The daemon enforces idempotent append keyed on `dedupe` (see `02-daemon-and-ipc.md`):
duplicates are dropped, and fields the duplicate carries that the stored event lacked are
**merged** into `ext` (fill-missing merge semantics) — so a second, richer source enriches rather than
duplicates. This is both the dedup guarantee and the "enrich from multiple verified sources"
mechanism from the brief.

### Delivery model — the honest statement

**LevelDB does not emit change events of any kind, in-process or cross-process. The DAEMON is
the event stream, the LOG is the truth.** Mechanics:

1. The daemon is the **only** writer (it owns the single LevelDB handle).
2. On each committed write that should be observable, the daemon appends `evt:<seq>` and
   assigns the monotonically increasing `seq` (it can do this without coordination because it is
   the sole writer; `seq` derives from `meta:seq`).
3. The daemon **broadcasts a wake-up** `{ seq }` to every subscribed client over the socket
   (see `02-daemon-and-ipc.md`). The broadcast is a *signal*, not the payload.
4. Each client tracks its last-seen `seq` (its **watermark**) and reads the range it has not yet
   seen (`evt:` from `watermark+1`). A missed or coalesced broadcast costs only latency — the
   next read catches up — so **no event is ever lost**. This is the same correctness invariant
   CouchDB's `_changes?since=` provides, reimplemented in a few dozen lines because Sumo controls
   both ends.
5. **In-process** consumers inside the daemon (e.g. an in-daemon orchestrator) receive events
   directly via an `EventEmitter`/async-iterator off the writer path — no socket, no polling.

Plugin subscriptions route through Sumo's event bus (the client library), never by reading
LevelDB directly. This preserves ordering, redaction, filtering, and capability boundaries, and
lets meta-plugins wrap delivery.

### Client API (hides the daemon/socket entirely)

```js
/**
 * @typedef {Object} SumoDb
 * @property {(key:string)=>Promise<any|undefined>} get
 * @property {(key:string, value:any, opts?:{ttlMs?:number})=>Promise<void>} put
 * @property {(key:string)=>Promise<void>} del
 * @property {(prefix:string, opts?:{limit?:number, reverse?:boolean})=>AsyncIterable<[string,any]>} scan
 * @property {(event:object)=>Promise<number>} append   // returns assigned seq
 * @property {(opts:{since:number, filter?:EventFilter}, handler:(evt:object)=>void)=>Unsubscribe} subscribe
 * @property {(query:string, opts?:object)=>Promise<SearchHit[]>} search
 */
```

`subscribe({ since, filter }, handler)` first flushes the backlog from `since`, then streams live
— so a late subscriber still receives everything in order. Filtering is **daemon-side** by
`type`/`session`/`source` prefix, so a hook script subscribing only to `tool.pre` is not woken
for every transcript line.

## Search (the one real cost of dropping SQL)

LevelDB has no query language or full-text engine. For the knowledge-base and dependency
plugins, the **daemon maintains an inverted index** (`idx:fts:` keyspace) using a pure-JS,
ESM-friendly library — **`minisearch`** (RECOMMENDED) or `flexsearch`. The index is updated as
documents are written and persisted into the same store. Exposed via `db.search()`. Swap point
is isolated behind that one method if full-text ever outgrows the in-process index.

- Optional semantic search (knowledge plugin) is **opt-in** and out of 1.0 default scope; if
  enabled, embeddings are stored as JSON vectors and ranked in-process. Pulling a vector index
  is a later decision (``).

## Retention / TTL / redaction

- **TTL** is implemented with the `ttl:` index: writing a value with `ttlMs` also writes a
  `ttl:<expiresAt>:<key>` pointer; the daemon's sweeper periodically scans `ttl:` up to `now`
  and deletes both the pointer and the target.
- **Defaults :** raw artifacts / `raw:` 14 days; normalized events `evt:`/`txn:`
  90 days; durable records (handoffs, knowledge, package intelligence) opt-in / no expiry.
- **Redaction** runs on raw payloads *before* they are written (§12), storing redaction
  descriptors so evidence shape is preserved without the secret.

## Plugin storage isolation

Each plugin receives a `db` handle scoped to its own sublevel (`kv:<plugin>`). It cannot read or
write another plugin's keys by default. Cross-plugin access requires a declared, user-approved
capability grant (§12 trust boundaries).

## Compatibility considerations

- **Backend:** `classic-level` (LevelDB) vs `rocksdb`-backed for higher write
  throughput. Default `classic-level`; revisit if event volume is high.
- **Semantic search** in the knowledge plugin: in-1.0 opt-in vs deferred.
- **Multi-project isolation:** one global store at `~/.sumo` vs per-project
  `.sumo/` stores vs both. Recommend: global store keyed by project, with the daemon scoping by
  project root; a per-project store is a later option.
