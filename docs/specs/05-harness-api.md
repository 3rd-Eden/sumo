# 05 — Harness API

## A harness adapter is an instance of the common adapter pattern

Per `CONVENTIONS.md` §3a, a harness adapter is NOT a bespoke shape. It is the common
`sumo/adapter` pattern specialized: a class with `id`/`can`/`config` props, the `read`/`write`
ingest/act duality, flat registration, shared eventing, capability degradation, one conformance
suite. The only harness-specific additions are the **`transport`** prop and the
**`read`/`write` frame vocabulary**.

## Primus-shaped: transport is a swappable class prop

The server-vs-pipe split (`04`) is handled the way Primus handles websockets-vs-engine.io: a
swappable **transport** (Primus's "transformer"). The harness's logic is written against a
normalized **`Session`** (Primus's "Spark" — a Duplex stream), not against the transport. So the
same harness logic runs whether bytes flow over a PTY/pipe or an HTTP/SSE+JSON-RPC socket.

**No statics. Everything is a class prop** (per your direction). The transport is an instance
assigned to the `transport` prop — not selected by a static helper call.

```js
import { Harness } from 'sumo/harness';
import { Pipe } from 'sumo/harness/transport';   // a Transport class (the "transformer")
import { z } from 'zod';

export class ClaudeCode extends Harness {
  id  = 'claude-code';
  can = { stream: true, injectStdin: true, hooks: true, defer: true, key: true };
  config = z.object({ bin: z.string().default('claude') });

  // TRANSPORT as a class prop — swap this instance to change backend kind.
  transport = new Pipe({
    command: this.config.bin,
    args: ['-p', '--output-format', 'stream-json', '--verbose',
           '--input-format', 'stream-json', '--replay-user-messages']
  });

  // READ (ingest): one inbound transport frame -> 0+ normalized events.
  // Delegates format parsing to the `jsonl` package (08) — the adapter does NOT embed a parser
  // (CONVENTIONS §3d). `this.event(...)` normalizes, dedupes, emits, ingests.
  *read(frame) {
    for (const evt of this.parser.stream(frame)) {   // this.parser = the sumo/parser adapter for this harness (08)
      yield this.event(evt.type, evt, { id: evt.id });   // id optional; see Dedup
    }
  }

  // WRITE (act): a Sumo intention -> bytes/calls the transport understands.
  write(action) {
    if (action.kind === 'prompt') {
      return JSON.stringify({ type: 'user', text: action.text }) + '\n';
    }
    // key / command / approval handled here or inherited defaults used
  }
}
```

```js
sumo.harness(ClaudeCode);   // flat registration — same verb shape as sumo.messenger / sumo.use
```

An **OpenCode** harness is the *same shape*: `transport = new Server({ url, sdk })`, `read(frame)`
parses SSE/JSON-RPC events instead of JSONL lines, `write(action)` calls `session.prompt` instead of
writing stdin. **Same base, same `Session` out, transport + frame vocabulary swapped.** That is the
server-vs-pipe split resolved by composition (a swapped transport prop), not by an inheritance fork.

## The `Transport` contract (the "transformer")

A transport is a small Duplex-like contract; `Pipe` and `Server` are Sumo-provided implementations,
and a third party can supply their own (module-lock-in prevented, per Primus's goal):

```js
/**
 * @typedef {Object} Transport
 * @property {() => Promise<void>} open                       - start the process / connect
 * @property {(bytes: string|Buffer) => Promise<void>} send   - write to the channel
 * @property {() => AsyncIterable<Frame>} frames              - inbound frames (lines / SSE events / rpc msgs)
 * @property {() => Promise<string>} capture                  - current raw output snapshot (pipe/PTY) or '' (server)
 * @property {() => Promise<void>} close                      - graceful close
 * @property {() => Promise<void>} kill                       - forced kill
 * @property {{ alive: boolean, heartbeat?: number }} health  - liveness for stall detection
 */
```

- **`Pipe`** owns the verified `child_process` pitfalls once: pipe-buffer backpressure, `detached`/
  `unref` backgrounding, `exit`/`close` `(code, signal)`, graceful-quit → SIGTERM → SIGKILL, and the
  PTY wrapper (node-pty / tmux per `04`) for interactive steering.
- **`Server`** owns connect/reconnect (Primus-style randomized exponential back-off), SSE/JSON-RPC
  framing, and server-initiated approval requests (Codex app-server / OpenCode `permission.ask`),
  surfaced to the `Session` as `respondApproval`.

## The `Session` is the Spark

`sumo.run(...)` returns a `Session` — the normalized, Duplex, transport-agnostic handle (the Spark).
Its methods (`send`/`key`/`command`/`capture`/`join`/`done`/`end`/`respondApproval`, per `03a`/`04`)
are **built and bound by the base** around the author's `transport` + `write`. The author never
constructs a `Session`. `respondApproval` exists only when `can` says the transport supports
server-initiated approvals (declare-don't-fake).

## Inherited machinery (written once in the base)

The author writes `read`/`write`/`transport` + `id`/`can`/`config`. The base owns everything else:

- **`Session` construction + method binding** around the transport.
- **Install-and-verify** (`04`): choose a capable launch mode, install hooks, fire a self-test,
  freeze `SessionCapabilities`. `can` is the declared ceiling; the base verifies reality.
- **Activity / stall / blocked-prompt detection** (the nexpect expect-loop lesson): output hashing +
  prompt-pattern matching for `pipe`, explicit events for `server`; emits `awaiting_input`/`idle`/
  `stalled`/`blocked`/`dead`.
- **Event emission with dedupe/merge** (next section) into the daemon event log.
- **Redaction-on-ingest** (`12`/security): secrets stripped from raw frames before storage.
- **Native-id correlation** recorded on the session document (spawn-only ⇒ a fact, not inference).

## Dedup: the same logical event must not appear twice

**Problem (caught in review):** the same logical event can arrive twice from different sources — once
from the harness's live stream (`read()` of a stdout frame) and once from the on-disk transcript that
`agent-artifacts` tails (Claude writes the same turn to both stream-json AND `~/.claude/projects/
*.jsonl`). Without dedup, every tool call/message/result is doubled.

**Decision (made deliberately): source-preferred id, automatic content-hash fallback, enforced
idempotently at the daemon — the author almost never thinks about it.**

- **The base always produces a `dedupe` key for every event.** Default: a content hash of
  `(sessionId, kind, normalized-payload, monotonic-position)` — the position prevents genuinely
  distinct identical events (the agent says "ok" twice) from collapsing.
- **When the artifact carries a natural id** (Claude `uuid`, Codex line id, OpenCode part id), the
  author surfaces it via `this.event(type, raw, { id })` and the base prefers it over the hash. This
  is exactly Primus's `idGenerator` rule (use transport id if present, else generate
  deterministically), applied to events. The `id` is an **optional override, not a required field** —
  the safe default makes duplication impossible-by-default rather than possible-on-mistake.
- **The daemon enforces idempotent append keyed on `dedupe`** (sole writer ⇒ the natural chokepoint,
  per ). It keeps a `seen:<dedupe> → seq` index; a duplicate key is a no-op returning the existing
  `seq`. Whichever source arrives second is dropped. See `02-daemon-and-ipc.md`.
- **Merge-on-duplicate, not pure drop.** Sources differ in richness (the stream may lack a tool
 result the JSONL has; Cursor's transcript omits some tool outputs). On a duplicate key the daemon
 **merges fields the second event has that the first lacked** (into the `ext` bag, fill-missing merge
 semantics). The duplicate becomes the "enrich from multiple verified sources" mechanism the brief
 asked for — not waste.
- **Visible, not hidden.** The `dedupe` key is a stored field, inspectable in the daemon and
  `sumo doctor`. Automatic ≠ concealed; the author can see why two events collapsed and override.

A harness **declares whether its live stream and on-disk transcript overlap**, so the base/ingestion
know to expect and dedup duplicates rather than treating double-delivery as a bug:

```js
  overlaps = { stream: true, transcript: true };   // claude: same turns in both -> dedup expected
```

## Conformance (one suite, every harness) — includes a dedup test

Per `CONVENTIONS.md`: validate `read()` output against the event schema; assert declared `can` flags
match exercised behavior; assert unsupported ops degrade to diagnostics. **Plus the dedup assertion:**
feed the same logical event through BOTH the live-stream path and the transcript path; assert the
daemon collapses them to one `seq` and merges the richer fields. This makes "no duplicate events" a
*tested property of every harness adapter*, not a hope — the bug cannot regress.

## Backend selection per harness (the four)

```
claude-code → Pipe transport (PTY wrapper for interactive); read=JSONL lines; write=stdin stream-json
cursor      → Pipe transport (PTY wrapper for interactive); read=stream-json; write=stdin
opencode    → Server transport (HTTP+SSE via @opencode-ai/sdk); read=SSE events; write=session.prompt
codex       → Server transport (JSON-RPC via codex app-server, stdio); read=rpc notifications; write=rpc
```

Cursor discovery is intentionally limited to automation CLIs: `agent`, `cursor-agent`, or an explicit
`SUMO_CURSOR_BIN`/adapter `bin` override that is not the desktop `cursor` launcher. A basename of
`cursor` is reported unavailable without execution so Sumo never opens the desktop editor when probing
or spawning an automation session.

## Conventions conformance (CONVENTIONS.md §3b)

- **Outcome envelope (aligned #1):** `write` and session control operations that can fail return the
  shared `Result` (`{ ok, value }` | `{ ok:false, reason, code }`), not raw values or throws.
- **Capability-failure (aligned #2):** invoking an op `can` reports unsupported (e.g. `key` on a
  `server` transport with no terminal) returns `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }` surfaced as
  a diagnostic — identical to every other surface. Never a silent no-op or fake success.
- **Envelope (aligned #3):** events from `read` share the normalized + `ext` + `dedupe` wrapper with
  messenger work items; the *payload* (an event = something that happened) stays distinct from a work
  item (divergent #2).
- **Error vs return (aligned #4):** `read`/`write` throw only for programmer error (malformed override,
  bad config); operational failures (transport closed, harness rejected) are `Result`s.
- **Stream vs effect (divergent #1):** `read` returns a stream of events, `write` performs an effect —
  intentionally different, not drift.

## Compatibility considerations

-   Codex transport detail: app-server stdio (stable, per-process) vs `--listen unix://`
  (shared, experimental) — default stdio (from `04`).
-   Whether `capture()` belongs on the `Transport` contract for `server` kinds (which
  have no screen) or is `pipe`-only with `server` returning `''`. Recommend the latter (declared via `can`).
-   PTY backend for `Pipe`: node-pty vs tmux (from `04`; leaning node-pty now that
  only 2 harnesses need a terminal).
