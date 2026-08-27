# `sumo/harness` — spawn + drive the coding harnesses, normalize their live output

The control adapter layer. It launches an agentic coding harness, drives it (prompt / steer /
approve / end), and turns its **live** output into normalized events on the one event log. It is the
live-stream ingestion source; the on-disk transcript is the other source
([`agent-artifacts`](../agent-artifacts)), and the daemon collapses the two by `dedupe` key.

Imported as `sumo/harness` and `sumo/harness/transport`.

Harness binary configuration lives under `harness.<id>.bin` in `sumo.yml`. The supported Sumo-owned
environment variables are listed in [config](../config/README.md).

> **Scope.** Operates only on sessions Sumo launches. It **composes** rather than
> rebuilds: `read()` delegates to the `sumo/transcript` parser; normalized events are appended through
> the `sumo/db` daemon client (the daemon stays the sole LevelDB writer — the harness is a client, not
> an owner); `dedupe` keys use `sumo/db/dedupe`. No foreign-attach, no agent-artifacts tail, no CLI,
> no orchestration here — those are later layers.

---

## The contract

A harness **is an adapter**: a class extending `Harness`, declaring `id` / `can` / `config` /
`transport` / `overlaps` as instance props, covered by one parametrized conformance suite. The base
owns the machinery; an author writes the harness-specific mapping plus a swappable **transport**.

```js
import { Harness } from 'sumo/harness';
import { Pipe } from 'sumo/harness/transport';

export class ClaudeCode extends Harness {
  id  = 'claude-code';                                  // MUST match a sumo/transcript parser key
  can = { stream: true, injectStdin: true, hooks: true, defer: true, key: true, capture: true };
  config = z.object({ bin: z.string().default('claude') });
  overlaps = { stream: true, transcript: true };        // same turns reach both live + transcript sources

  transport = new Pipe({ command: this.ctx?.config?.bin ?? 'claude', args: [/* stream-json flags */] });

  // WRITE (act): a Sumo intention -> an external effect. Returns a Result, never raw bytes.
  async write(action) { /* … this.transport.send(...) … */ }
  // READ (ingest) is inherited: it composes this.parser (the transcript parser) by default.
}
```

The author writes **`id` / `can` / `config` / `transport` / `overlaps`** and **`write`**, plus
optionally **`read`** (a non-parser framing), **`prepare`** (inject a positional prompt at spawn), or
**`start`** (orchestrate a handshake). Everything else — the `Session`, the read loop, dedupe, append,
lifecycle, capability gating — is the base.

### Transport as a swappable class prop

The pipe/server divergence is handled the way Primus handles its transformers: a `Transport` instance
assigned to the `transport` prop, **not** an inheritance fork in the adapter. The base presence-probes
the transport (`typeof transport.request`) and intersects with `can`, so an absent effector degrades
to `SUMO_CAP_UNSUPPORTED` rather than being faked.

| transport | kind | framing | effectors |
|---|---|---|---|
| `Pipe` | `pipe` | newline-JSON over stdio | `send`; `key`/`capture` via a tmux pane (interactive mode) |
| `CodexAppServer` | `server` | JSON-RPC 2.0 over stdio | `request` (id-correlated), `respondApproval` (server-initiated approvals) |
| `CopilotServer` | `server` | `@github/copilot-sdk` over the npm-installed Copilot CLI | `request`, `respondApproval`, `.github/hooks/` file-hook loading |

The Copilot SDK is an optional peer dependency so transcript, configuration, and
other harness integrations do not install its platform-specific runtime. Install
`@github/copilot-sdk@1.0.4` alongside Sumo before using the Copilot harness.

> The server-kind transports here are **concrete siblings** (`CodexAppServer`, `CopilotServer`), not a
> fake generic `Server`. Each one speaks its real protocol — Codex JSON-RPC, Copilot SDK/JSON-RPC —
> without pretending the details are universal. A future `OpenCodeServer` is another sibling, not a
> forced subclass.

---

## The four harnesses

| harness | kind | spawn / channel | prompt delivery | approvals | observation |
|---|---|---|---|---|---|
| `claude-code` | pipe | `claude -p --input/output-format stream-json --replay-user-messages` | stdin JSON user message | — (hooks) | event-stream |
| `cursor` | pipe | `agent` or `cursor-agent -p --force --output-format stream-json` | **positional** (no stdin streaming) | — (hooks) | event-stream |
| `codex` | server | `codex app-server` JSON-RPC; `initialize`→`thread/start` handshake in `open()` | `turn/start` | **server-initiated** `respondApproval` | event-stream |
| `copilot` | server | `@github/copilot-sdk` over the npm-installed Copilot CLI | `session/send` | **server-initiated** `respondApproval` | event-stream + hooks |

Real divergences became `can` flags or hooks, never base assumptions: Cursor has no `--input-format`,
so its first prompt is a CLI argument injected in `prepare()` and follow-up `send` honestly returns
`SUMO_CAP_UNSUPPORTED`; Codex and Copilot have no terminal, so `key`/`capture` are unsupported; Codex
and Copilot declare `can.approve` from captured approval round-trips. Copilot declares hook support
and installs documented file-backed hooks, and the SDK transport enables `.github/hooks/` loading so
installed repository hooks execute in Sumo-spawned sessions, including the captured
`permissionRequest` decision hook. Cursor discovery deliberately uses only the automation CLIs
(`agent`, then `cursor-agent`) and rejects the desktop `cursor` launcher without executing it.

### Capabilities are two independent axes

`run(prompt, opts)` computes a frozen [`SessionCapabilities`](src/base/schema.mjs) descriptor.
**Interactive control** (`canSendKey`/`canCapture`) and **clean event source**
(`observationSource`) are orthogonal:

- **default stdio mode** → `observationSource: 'event-stream'` (clean stream-json `read()`),
  `canSendKey: false`. The 1.0 read/write path.
- **tmux pane (interactive) mode** → `canSendKey: true`, but `observationSource: 'transcript-file'`:
  a pane mixes stream-json with TUI redraws, so it is **not** treated as a clean event source — live
  events for a pane session come from the on-disk transcript, not a pane scrape. This is the
  committed architecture, built expecting it, not a degradation to paper over.

---

## Events & dedup

The base maps each parser `NormalizedEventInput` to a `sumo/db` `EventInput` explicitly (no nesting),
adding `source: 'session'`, `adapter: <id>`, and the **`dedupe`** key: a source-preferred
natural id (`naturalDedupe('msg', message.id)`) when the parser surfaces one, else a content hash with
a monotonic position. Where both the live stream and the on-disk transcript yield the same key (Claude
`msg_...`, Codex `call_...`), the daemon collapses them; where they do not (Codex plain messages,
Cursor), collapse is not asserted. Synthesized lifecycle
events (`session.ended`/`session.dead`/`session.rapid-death`) originate here on transport close.

---

## Usage

```js
import { harnesses } from 'sumo/harness';                  // registry keyed by harness id

const session = await new harnesses['codex']({ db, config: { cwd } }).run('Refactor foo()');
for await (const event of session.join()) {                // normalized 07 events + dedupe
  if (/requestApproval/.test(event.type)) {
    await session.respondApproval({ requestId: event.ext.native.id, decision: 'accept' });
  }
}
await session.done();

await session.key('Enter');     // -> { ok:false, code:'SUMO_CAP_UNSUPPORTED' } unless an interactive pane
```

Registration into the plugin runtime is the flat verb (the factory form the runtime implements today):

```js
sumo.harness('codex', (hctx) => new Codex(hctx));   // hctx carries config, store, signal, db, session()
```

---

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.mjs` | Public surface: `Harness`, the built-in adapters, the `harnesses` registry. |
| `base/Harness.mjs` | Base: `run()` lifecycle, Session binding, read loop, `toEvent()` mapping, dedupe, append, `capabilitiesFor()`, degradation. |
| `base/schema.mjs` | `Result`/`ok`/`fail`, `HarnessAction`, `SpawnRequest`, `SessionCapabilities`, `HarnessCan`. |
| `transport/Transport.mjs` | Abstract transport contract (`open`/`frames`/`close`/`kill`/`health` + optional effectors). |
| `transport/Subprocess.mjs` | Shared child-process core (backpressure, detached/unref, exit/close, SIGTERM→SIGKILL). |
| `transport/Pipe.mjs` | Pipe kind: newline-JSON framing, `send`, rolling `capture()`, tmux interactive pane. |
| `transport/CodexAppServer.mjs` | Server kind: JSON-RPC framing, `request`, the handshake, `respondApproval` + `frameApprovalResponse`. |
| `transport/tmux.mjs` | tmux pane wrapper (`new-session`/`send-keys`/`capture-pane`). |
| `adapters/<harness>.mjs` | Per-harness `id`/`can`/`config`/`transport` + `write`. |

---

## Tests & fixtures

The deterministic suites run against **real** captured fixtures and real subprocesses — no mocked
harness payloads. `read()` is driven by `sumo/transcript`'s committed stream fixtures (the inbound
frames); the codex approval request is a committed real capture
([`fixtures/codex/control/PROVENANCE.md`](test/fixtures/codex/control/PROVENANCE.md)).

```bash
node --test packages/harness/test/contract.test.mjs packages/harness/test/conformance.test.mjs packages/harness/test/integration.test.mjs
```

> `node --test packages/harness/test` does **not** work — it treats the directory as a module. Pass
> the files (or run `pnpm test` for the whole repo).

- **`contract.test.mjs`** — transport mechanics against real `node` subprocesses (framing, `send`,
  `capture`, close/health).
- **`conformance.test.mjs`** — the one parametrized suite over the three adapters: `can` matrix,
  `read()`→`EventInput` validity, dedupe reproduces the parser identities, capability degradation,
  capability-axis independence, secret audit.
- **`integration.test.mjs`** — **real** integrations: event wiring through a live `sumo/db` daemon;
  the tmux pane (`key`/`capture`, gated on tmux); the Codex JSON-RPC handshake against real
  `codex app-server` (gated on codex, no model call); the captured approval frame + verified reply
  framing.

**Live smoke (runs by default).** Spawns the real CLIs and makes real model calls when the relevant
harness is available; verifies the full control path including Codex and Copilot approval round-trips
(request surfaces → `respondApproval(accept)` → effect), plus Copilot repository file hooks installed
through Sumo's reconciler and executed by the SDK transport. Missing external CLIs/auth are reported as
node:test skips with explicit reasons, never mocked:

```bash
node --test packages/harness/test/live.test.mjs
# this machine's PATH `claude` is a wrapper shim that mangles --verbose; point at the real binary:
CLAUDE_CODE_EXECPATH=/path/to/claude node --test packages/harness/test/live.test.mjs
```

---

## Known limitations / deferred (for the next engineer)

- **OpenCode server transport is deferred.** Its parser + stream fixtures already exist in
  `sumo/transcript`; a future `OpenCodeServer` should follow the concrete-server sibling pattern used
  by `CodexAppServer` and `CopilotServer`.
- **Resume / persistence** (`--resume`, `thread/resume`) is not wired — spawn-and-run only for now.
- **`session.idle`/`session.stalled` timers** use large default thresholds; tuning, hook-based
  steering, and the class-based `sumo.harness(Class)` verb are follow-ups.
