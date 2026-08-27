# 04 — Session Control & Harness Backends

> Supersedes the session-control material in the main package (§6) and corrects the harness
> capability matrix (§1) for Codex. Read with `CONVENTIONS.md` (adapter pattern) and
> `02-daemon-and-ipc.md` (sessions are tracked in the daemon-owned store).

## Scope: Sumo-spawned sessions only (SETTLED)

  The 1.0 operates **only on sessions Sumo launches itself.** The premise is that an
engineer who adopts the ecosystem runs their harnesses *through* Sumo (`sumo run …`, the
orchestrator, or a messenger-driven spawn), not as bare terminals Sumo later tries to attach to.
A session whose **launch Sumo never controlled is out of scope for 1.0.**

**Soft edge (still in scope):** a Sumo-spawned session that a human then works in interactively —
Sumo launches the harness, hands the engineer an attached terminal, they share the keyboard — is
**in scope**, because Sumo still controlled the launch. This is why the `pipe`/PTY backend and the
`join` flow still matter. What is out of scope is only "a session whose *launch* Sumo never
touched."

### Consequences of spawn-only (these simplify the 1.0)

- **Capabilities are always `controlled` + verified, never merely discovered.** Because Sumo owns
  every launch, it chooses the mode and verifies the result. There is **no
  `controlled`/`discovered`/`unavailable` provenance split in 1.0** — every capability value is a
  thing Sumo chose and confirmed. (Provenance is the seam to add later; see boundary below.)
- **No foreign-attach machinery in 1.0.** No PID-hunting, no guessing a foreign session's launch
  mode, no heuristic reconciliation of a transcript whose origin Sumo didn't control.
- **Native-id correlation is a recorded fact, not an inference.** Sumo spawned it, so it captures
  the native id (Claude `session_id`, Codex `threadId`, OpenCode session id, Cursor `session_id`)
  from the launch output / first events and records it on the session document. The cwd+pid+timestamp
  heuristic in `09-agent-artifacts.md` becomes a fallback, not the primary path.
- **Steering is reliable by construction.** Sumo always launches in a hook-capable / approval-capable
  mode and verifies it; guardrail plugins degrade to observe-only only on genuine harness failure
  (the exception), not as a routine attached-session case.

### What spawn-only does NOT remove (keep these as hard requirements)

- **Spawn-mode control is still a per-harness, version-tracked job.** Owning the launch puts Sumo in
  the driver's seat; it does not auto-select the right gear. Each adapter MUST actively choose the
  hook-capable invocation at spawn and re-assert it as harness defaults shift (e.g. Claude `--bare`
  becoming the `-p` default would silently kill hooks even on a Sumo-spawned session). The
  **install-and-verify protocol below is mandatory on every spawn**; verification failure is now a
  real error (Sumo controlled the launch and it still didn't fire), not an expected limitation.
- **The transcript-vs-stream observation split persists.** It is a property of the harness, not of
  who spawned the session: OpenCode emits a live SSE stream (no JSONL file); Cursor transcripts may
  omit tool outputs. The ingestion layer still normalizes "transcript file" and "event stream" into
  the same shapes, and adapters still declare their observation source and known gaps.

### Extensibility boundary (do not design foreign-attach OUT)

Keep the **per-session capability descriptor** and the **ingestion source abstraction** in place even
though, in 1.0, every capability is `controlled` and every native id is known. They cost almost
nothing now and are the seam through which "observe a foreign session" could be added later without
re-architecting. **Do not build** foreign attach; **do not actively design it out.** This honors the
brief's extensibility principle without spending 1.0 effort.

> **UPDATE (June 2026 — see "Always-on, project-scoped transcript ingestion"):** the
> *observe-a-foreign-session* half of this seam has since been built, deliberately and bounded:
> `sumo attach` hands off to the harness's native interactive resume, and a project-scoped, opt-out
> ingestion service auto-consumes a foreign/native session's transcript into the DB (an `observed`,
> non-controllable `ses:` doc). Foreign *control* (driving a session Sumo didn't spawn) remains out of
> scope — observation only. The capability-descriptor + ingestion-source abstractions this section
> preserved are exactly what made that additive, as intended.

## Install-and-verify protocol (MANDATORY on every spawn)

On each Sumo-spawned session, before the session is reported `ready`:

1. **Choose a capable mode.** The adapter selects launch flags/config that keep the needed
   capabilities alive (hooks fire, stream/approval channel on). It MUST NOT rely on harness
   defaults, which drift.
2. **Install hooks (with consent).** Where steering is needed, Sumo writes its hook config into the
   harness's own config location (consented setup step; see `16-security-privacy.md`).
3. **Verify by self-test.** Trigger a benign event that should produce a known hook/stream signal
   (e.g. a no-op tool or a session-start probe) and confirm the corresponding normalized event
   arrives within a timeout.
4. **Record the verified capability descriptor** on the session document. Capabilities that failed
   verification are marked unavailable for that session and steering-dependent plugins receive a
   `SumoDiagnostic` (`SUMO_STEERING_UNVERIFIED`) — never a silent assumption that they work.

```js
/**
 * @typedef {Object} SessionCapabilities  // computed per session at spawn, then frozen
 * @property {boolean} canDeny
 * @property {boolean} canModifyInput
 * @property {boolean} canInjectContext
 * @property {boolean} canAsk
 * @property {boolean} canDefer
 * @property {boolean} canSendKey
 * @property {'transcript-file'|'event-stream'} observationSource
 * @property {boolean} transcriptComplete      // false e.g. for Cursor (may omit tool outputs)
 * @property {boolean} steeringVerified         // result of the self-test
 */
```

**Operating rule :** a workflow/plugin that requires steering MUST run on a Sumo-spawned,
hook-verified session. Observation-only plugins work on any Sumo-spawned session; steering-dependent
plugins get their guarantees only after `steeringVerified === true`.

## Correction recorded

Earlier drafts under-credited Codex, leaving it at "`codex exec` subprocess / PTY" while
elevating OpenCode to its HTTP API. That was an inconsistency: if OpenCode is controlled via its
server API rather than a PTY, Codex must be evaluated the same way. Research (June 2026) shows
Codex has **four** non-TTY control surfaces, and OpenAI explicitly built one of them
(`app-server`) to be the way clients drive Codex. PTY is therefore a **fallback** for Codex, not
the primary, exactly as for OpenCode.

## Two backend kinds (not "PTY + exceptions")

The `SumoSession` base class treats control channels as **two first-class backend kinds**. PTY is
not the default with everything else as a special case.

- **`server` / RPC backend** — the harness exposes a structured, bidirectional control channel
  (HTTP+SSE, or JSON-RPC). Sumo connects to it; prompts, approvals, and streamed events flow as
  structured messages. Used for **OpenCode** and **Codex**.
- **`pipe` backend** — the harness is a subprocess driven over stdin/stdout (optionally
  newline-JSON streaming), with a **PTY wrapper** available when interactive steering / TUI
  scraping is needed. Used for **Claude Code** and **Cursor**.

This split is cleaner than the matrix implied: two harnesses are best driven by a structured
channel, two by subprocess pipes. The base class exposes one `SumoSession` contract; each backend
kind implements it (`CONVENTIONS.md` §4 adapter pattern).

```js
/**
 * @typedef {'server'|'pipe'} BackendKind
 * @typedef {Object} SessionBackend
 * @property {BackendKind} kind
 * @property {(req:SpawnRequest)=>Promise<HarnessHandle>} spawn
 * @property {(h:HarnessHandle, input:string)=>Promise<void>} send       // prompt/stdin
 * @property {(h:HarnessHandle, key:KeyName)=>Promise<void>} key         // pipe/PTY only; server emulates or NACKs
 * @property {(h:HarnessHandle, line:string)=>Promise<void>} command     // slash command
 * @property {(h:HarnessHandle)=>AsyncIterable<RawEvent>} events         // SSE / JSON-RPC notifications / parsed stdout
 * @property {(h:HarnessHandle, decision:ApprovalDecision)=>Promise<void>} [respondApproval] // server backends w/ approvals
 * @property {(h:HarnessHandle, opts?:{force?:boolean})=>Promise<void>} end
 */
```

Adapters declare which operations they truly support via `capabilities`; unsupported ops degrade
per the documented fallback chain and emit a diagnostic — never a silent no-op (`CONVENTIONS.md`
§4). E.g. a `server` backend with no key-event concept reports `canSendKey:false`, and `key()`
returns a diagnostic rather than pretending.

## Corrected per-harness control strategy

| Harness | Primary control | Transport | Resume / persistence | Approvals & streaming | PTY role |
|---|---|---|---|---|---|
| **OpenCode** | HTTP server + `@opencode-ai/sdk` | TCP port (`opencode serve --port`) + SSE `/event` | session reuse via SDK/HTTP | `session.prompt[_async]`, `permission.ask` | not used |
| **Codex** | **`codex app-server`** (primary); `codex mcp-server`; `codex exec` | **JSON-RPC 2.0**: stdio (default, stable); `--listen unix://PATH` or `ws://` (experimental/unsupported) | threads persist (`~/.codex/state.db`); `thread/start`, `thread/resume` by id | server-initiated approval requests: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel`; streaming turn/item events | **fallback** only (scrape human TUI) |
| **Claude Code** | streaming stdin/stdout subprocess | pipes (`--input-format stream-json` + `--replay-user-messages`, `--output-format stream-json`) | `--resume`, `--continue` | hooks incl. `defer` (headless pause/resume) | interactive steering |
| **Cursor** | `agent` / `cursor-agent -p` subprocess | pipes (`--output-format stream-json`) | `--resume` | hooks (deny reliable; allow/ask buggy) | interactive follow-ups; desktop `cursor` launcher rejected |

### Codex control surfaces (the four, ranked for Sumo)

1. **`codex app-server`** — RECOMMENDED primary. Bidirectional JSON-RPC 2.0 designed to expose
   the full harness as a stable, UI-friendly event stream. OpenAI tried MCP first and found its
   tool-oriented request/response model could not accommodate streaming diffs, approval
   workflows, thread persistence, or server-initiated requests; the app-server exists to do
   exactly those. Thread/Turn/Item event hierarchy streams incrementally; threads survive
   process restarts and resume by id. This is the genuine peer to OpenCode's HTTP API.
2. **`codex mcp-server`** — JSON-RPC over stdio, exposes `codex` + `codex_reply` tools; returns a
   stable `threadId`; "no ports, no daemons." Good when Sumo wants Codex as a plain MCP tool
   rather than a full driven session. Note: weaker for streaming/approvals than app-server (the
   reason app-server was built).
3. **`codex exec`** — NDJSON one-shot / CI; simplest; no live steering.
4. **PTY** — fallback only.

## Transport decision for Codex ``

The Codex app-server `--listen unix://PATH` option would let Sumo treat Codex almost identically
to OpenCode — a detached socket server the session manager connects to, sharable across Sumo
client processes. Architecturally tidy. **But that listener is flagged experimental and
unsupported.** Two paths:

- **Conservative (RECOMMENDED default):** spawn `codex app-server` per session and speak JSON-RPC
  over its **stdio**. Stable, "no daemons," matches OpenAI's documented-supported posture. Cost:
  the channel is per-spawned-process (the owning Sumo process holds it), not a shared listener.
  Cross-process visibility still works because session *state and events* live in the Sumo daemon
  store (`02-daemon-and-ipc.md`); only the raw control channel is process-local.
- **Tidy-but-experimental:** run `codex app-server --listen unix://~/.sumo/codex-<id>.sock` and
  connect over the socket, enabling a shared/detached control channel symmetric with OpenCode.
  Stability bet on an experimental listener.

Recommend conservative stdio for 1.0; revisit if a shared detached Codex channel becomes valuable
and the listener stabilizes.

## How approvals map to Sumo decision intents (server backends)

Codex app-server and OpenCode surface **server-initiated approval requests**, which is a richer
model than Claude/Cursor's hook-return decisions. Map them through the normalized decision model
(`12-hooks-and-steering.md`):

| Sumo intent | Codex app-server | OpenCode |
|---|---|---|
| allow | `accept` / `acceptForSession` | `permission.ask` → `status:allow` |
| deny | `decline` | throw in `tool.execute.before` |
| modify (policy) | `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` | mutate `output.args` |
| ask/defer | hold the approval request open (server waits) → surface to plugin/human | hold `permission.ask` open |
| cancel turn | `cancel` | abort session prompt |

Because these backends *wait* on a server-initiated request, Sumo gets `ask`/`defer` "for free"
on Codex app-server and OpenCode — the harness blocks until Sumo responds — whereas Claude
(`defer`) and Cursor (emulated) achieve it through hook-return mechanics. Encode this difference;
do not flatten it.

## Session lifecycle, ids, detection (unchanged in substance)

- **sessionid:** Sumo-owned stable `ses_<ulid>`, decoupled from native ids; native id
  (Claude `session_id`, Codex `threadId`, OpenCode session id, Cursor `session_id`) stored on the
  session document when discovered (correlation via cwd + transcript_path + timestamp; see
  `09-agent-artifacts.md`).
- **State machine:** `starting → ready → working → awaiting_input | blocked | idle → stalled`,
  plus `ending → ended` and `dead`. For `server` backends, `awaiting_input`/`blocked` are
  signalled by an open server approval request or an explicit idle event — no PTY scraping needed.
  For `pipe`/PTY backends, use output-hash activity detection + known prompt patterns to detect
  interactive prompts that never reach the transcript.
- **Liveness/stall/rapid-death/graceful-end-vs-kill:** as in main spec §6, with the refinement
  that `server` backends expose health more directly (OpenCode `/event` heartbeats; Codex
  app-server `/readyz`/`/healthz` when using a listener, or connection liveness over stdio).

## Backend selection per harness (summary the implementer should encode)

```
claude-code → pipe backend (PTY wrapper available)
cursor      → pipe backend (PTY wrapper available)
opencode    → server backend (HTTP + SSE via @opencode-ai/sdk)
codex       → server backend (JSON-RPC via `codex app-server`, stdio transport; mcp-server / exec as alternates; PTY fallback)
```

## Compatibility considerations

-   Foreign-session attach and capability provenance are **out of 1.0
  scope**; every session is Sumo-spawned, every capability is `controlled` + verified. The
  descriptor/ingestion-source seams are retained for future extension but not built out.
-   Codex transport: stdio app-server (stable, per-process) vs `--listen unix://`
  (shared/detached, experimental). Default stdio.
-   Whether to expose Codex via `mcp-server` (as an MCP tool) in addition to
  app-server (as a driven session) — they serve different orchestration patterns.
-   PTY library for the pipe-backend fallback: `node-pty` (native dep) vs a
  tmux-backed backend (external binary, but detach/attach + human takeover). With `server` backends
  covering OpenCode+Codex, PTY is now needed only for Claude Code and Cursor, which weakens the
  tmux-default argument — reconsider `node-pty`-first. Note the in-scope soft edge (human shares a
  Sumo-spawned terminal) is the main remaining driver for a PTY/`join` path.
