# 12 — Hooks & Steering

> The implemented adapters establish these harness contracts: Claude `pretool` →
> `hookSpecificOutput.permissionDecision ∈ {allow,deny,ask,defer}`; Claude `stop`/`subagent-stop`
> → top-level `decision:'block'` (+ `reason`), omit-to-allow, `stop_hook_active` loop guard; Cursor
> `stop` → `followup_message` (no `decision`), gated on `status==='completed'`; Cursor has
> `agent-response`/`agent-thought` observation hooks Claude lacks; Claude compensates with stop-time
> transcript scanning; subagent hooks are Claude-only; payload field names differ
> (Claude `tool_response`/`error` vs Cursor `tool_output`/`failure_type`+`error_message`). The
> attached real `.cursor/hooks.json` confirms Cursor's `version:1`, `prompt`-type matched hooks,
> and `stop.loop_limit`.
> Project-local
> `.codex/hooks.json` runs command hooks when Codex is in bypass-permissions mode. `SessionStart`
> and `UserPromptSubmit` were live-verified end to end through `sumo forward codex` → daemon →
> project plugin runtime → native block. Codex `PostToolUse` payload shape is captured from a real
> run; the budget-dependent tool/post/stop live chain remains a prerequisite, not a mock target.
> Copilot CLI supports
> repository hook files under `.github/hooks/*.json`, user hook files under `~/.copilot/hooks/` or
> `$COPILOT_HOME/hooks/`, settings-file hooks, and VS Code-compatible hook names. Its native
> decision output is Copilot-specific: `preToolUse` uses top-level `permissionDecision` fields and
> `permissionRequest` uses top-level `behavior:'deny'` + `message`, while
> `agentStop`/`subagentStop` use top-level `decision:'block'` + `reason`, not Claude/Codex's nested
> `hookSpecificOutput`. The repository-hook `permissionRequest` payload and deny round-trip are
> captured from the real SDK/file-hook path.
> OpenCode mechanisms remain provisional and must be self-probed by the adapter (`05`). Every hook
> surfaces as a normalized event or passthrough record; unsupported records are never dropped.
>
> Read with `03` (`before` verb), `03a` (capability-aware steering, `can.*`), `05` (harness adapter +
> install-and-verify), `07` (steering action vocabulary + event types), `10` (orchestrator drives
> outcomes; defer→pause), `16` (redaction).

## Hooks are the FULL surface, not just PreTool/PostTool deny

A full-surface policy plugin such as `campsite-rule` consumes
the *entire* hook surface: `sessionStart` (init state + inject context), `beforeShellExecution`
(matched guardrail), `postToolUse`/`postToolUseFailure` (observe verification outcomes),
`afterAgentResponse`/`afterAgentThought` (observe for dismissive language), and `stop`/`subagentStop`
(gate completion until findings resolved). So Sumo must expose **all** hook events to plugins —
observation hooks, matched guardrails, failure hooks, and rich stop/continuation — normalized where
they share meaning and surfaced where each harness differs. The `before(action)` decision verb (`03`)
is one slice; the rest are observations via `on(...)` and a `stop` gate.

## Two kinds of hook, both exposed

1. **Observation hooks → `on(<event>)`** (`07` vocabulary): `session.started`, `session.tool`,
   `tool.post`/`tool.fail`, `session.message`, `session.reasoning`, etc. Fire-and-forget; can't
   block; feed plugin state (campsite's finding ledger accumulates here). These join the event stream
   like any event (same `dedupe`, so a hook-sourced `tool.post` and a transcript-sourced one collapse).
2. **Decision hooks → `before(<action>)`** (`07` actions): `tool`, `prompt`, `finish`/`stop`. Run as
 the priority-ordered handler engine waterfall, return `{deny}`/merged-payload/`{defer}` etc. Block the agent, so they run
 under a tight timeout.

## Normalized decision intents → per-harness mechanism (verified table)

A plugin returns a `SumoDecisionIntent` (`03`/`03a`); the harness adapter translates it to the native
mechanism. Grounded in the maintainer's `SCHEMAS`:

| Intent | Claude (verified) | Cursor (verified) | Codex (verified / live-partial) | Copilot (official docs + local adapter) | OpenCode (matrix) |
|---|---|---|---|---|---|
| `allow` | omit `decision` / `permissionDecision:'allow'` | omit (allow is buggy — deny is reliable) | ⚠️ parsed, fails-open | omit output; absence of deny allows | `permission.ask`→`status:'allow'` |
| `deny` | `permissionDecision:'deny'` (pretool) / `decision:'block'`+`reason` (stop) | `prompt`-type matcher deny / exit 2 | `permissionDecision:'deny'` (tool) / `decision:'block'` (prompt/stop) | `preToolUse` top-level `permissionDecision:'deny'`; `permissionRequest` top-level `behavior:'deny'`; `agentStop`/`subagentStop` top-level `decision:'block'` | throw in `tool.execute.before` |
| `ask` | `permissionDecision:'ask'` | `permission:'ask'` (beforeShell/MCP only) | ❌ unsupported | ❌ unsupported by Sumo's Copilot hook adapter | `permission.ask` |
| `defer` | `permissionDecision:'defer'` (headless pause) | ❌ (emulate) | ❌ | ❌ | ❌ |
| `modify` | `updatedInput` (pretool) / `updatedToolOutput` (posttool) | `updated_input` (preToolUse) | ❌ parsed-unsupported | ⚠️ docs expose `modifiedArgs`; Sumo does not claim it until captured | mutate `output.args` |
| `inject` | `additionalContext` (UserPromptSubmit/SessionStart) | `additional_context` (sessionStart) | `additionalContext` | ⚠️ docs expose post-hook context outputs; Sumo currently observes those hooks only | `chat.message` |
| `stop`-gate | `decision:'block'`+`reason`, `stop_hook_active` guard | `followup_message`, gate on `status==='completed'` | Stop `decision:'block'` | `agentStop`/`subagentStop` `decision:'block'`+`reason` | emulate via deny+ask |

The `continue:false` / `decision:block` precedence (verified: takes precedence over other fields) is
how a hard stop overrides everything.

## Degradation chains (where a harness can't do the intent)

Capability-aware (`03a` `can.*`); never silent no-op. When unsupported, degrade down a documented
chain and emit a diagnostic:

- **`defer` → `ask` → `deny`+inject.** Claude can `defer` (headless pause); Cursor/Codex/OpenCode
  can't, so `defer` degrades to `ask` where available, else to `deny` with an injected explanation.
  A genuine human-pause `defer` that no harness supports natively becomes an **orchestrator-managed
  pause** (`10`): the orchestrator holds the session and surfaces an approval, rather than the hook
  faking it.
- **`ask` → `deny`+inject** where ask is unsupported (Codex) or buggy (Cursor allow/ask).
- **`modify` → `deny`+inject** where input rewrite is unsupported (Codex).
- **`allow`** is a no-op where allow is buggy (Cursor) — the absence of deny *is* allow.

The adapter declares what it can honor; the gap surfaces as a `SUMO_CAP_UNSUPPORTED` diagnostic
(§3b), and the plugin can inspect `e.can.*` to choose a different intent up front (the `03a` example).

## Cross-harness intent, per-harness implementation (the campsite lesson)

The same *goal* often needs **opposite mechanisms** per harness — verified in `campsite-rule`:

- **Catch dismissive language in agent output.** Cursor (interactive) has `afterAgentResponse`/
 `afterAgentThought` → scan **per-turn** via `on('session.message'/'session.reasoning')`. Claude has
 **no** such hooks → scan the **transcript at stop time** (Claude's `Stop` handler reads
 `transcript_path` and feeds every block through the detector). Sumo exposes both: a plugin registers
 the *intent* (observe agent output for a pattern), and the harness adapter routes it to per-turn
 hooks where they exist or to stop-time transcript scanning where they don't. The plugin author writes
 the detector once; the adapter picks the delivery.
 > ⚠️ **Capture-state caveat (capture corpus evidence):** Cursor's per-turn agent hooks are confirmed in
 > *interactive* hooks.json; under **headless `agent --print`**, capture corpus captures show
 > `afterAgentResponse`/`stop` are **not** emitted and must not be claimed until captured (§3f). So on
 > headless Cursor, the per-turn route may be unavailable and the intent degrades — the adapter
 > declares this via `can`, and the detector intent degrades like any other capability gap, never
 > silently dropped.
- **Subagent gating** is Claude-only (`subagentStop`); on harnesses without it, the intent degrades
  (gate the main stop only) with a diagnostic noting reduced coverage.

This is `CONVENTIONS §3a` in its hardest form: shared intent, adapter-specific delivery, never faked.

## Matchers are part of the hook contract

`campsite-rule`'s shell guardrail matches commands by regex (the `beforeShellExecution` matchers in
`.cursor/hooks.json`). So a decision-hook registration carries an optional **matcher** (tool name +
argument pattern), mapped to each harness's matcher mechanism (Cursor `matcher` field, Claude tool
matchers). A plugin registers `before('tool', fn, { match: /pnpm.*test/ })`; the adapter installs it
as a native matched hook where supported, else `sumo forward` matches it before invoking the waterfall.

## The stop gate is a first-class primitive

`stop`/`finish` is not just "deny finish" — it is the enforcement backbone (campsite blocks stop until
findings resolve). A `before('stop')` handler returns `{ deny, followup }`:
- **Claude:** `{ decision:'block', reason: followup }`, with the `stop_hook_active` loop guard honored
  by the adapter (don't re-block an already-blocking stop).
- **Cursor:** `{ followup_message: followup }`, gated on `status==='completed'`, with `loop_limit`
  (the `.cursor/hooks.json` shows `loop_limit:1`).
The loop budget ties into the orchestrator's `maxRounds` guard (`10`) so a stop-gate can't loop forever.

## Architecture: install → callback → decide → respond (option a, verified shape)

Two pieces of prior art converge on the same architecture: the maintainer's `campsite-rule/bin/hook.js`
("the engine and all detection logic live in `src/` — this adapter owns only payload normalization and
response formatting") and `capture corpus`'s `forward` entrypoint ("`capture corpus forward <tool> <nativeEvent>`…
loads the project config, normalizes through `normalized event model`, runs plugins through `relayist`, and maps the
result back into the native tool contract; not meant to be typed by hand"). Sumo mirrors this:

1. **Install** (`05` install-and-verify, `03` `install`): Sumo writes the harness's native hook config
 (`.cursor/hooks.json`, Claude settings, Codex `.codex/hooks.json`, Copilot `.github/hooks/sumo.json`) so each matched hook **forwards into a
 `sumo` CLI subcommand** — `sumo forward <harness> <native-event>` (the capture corpus `forward` pattern).
 Consent-gated (`16`). **There is NO dedicated `bin/hook.js`-style script** — the native hook
 entrypoint is the Sumo CLI itself (a `command`, / the CLI surface), not a separate generated
 file. This keeps the hook entrypoint inside the existing CLI/MCP capability contract rather than
 inventing a parallel script mechanism.
2. **Callback:** `sumo forward` reads the harness payload on stdin and **calls into the running daemon
   over the unix socket** (`02`) — the daemon owns the plugin logic, the event stream, and the
   orchestrator (sole-actor, `10`). The `forward` command is the *only* Sumo code that runs in the
   harness's process; it holds no decision logic — it normalizes the payload (via the parser, `08`) and
   forwards.
3. **Decide:** the daemon runs the `before(action)` waterfall (composition below), producing a
   normalized `SumoDecisionIntent`. Observation hooks also emit their event onto the stream here
   (un-normalizable hooks surface as passthrough events, §3e — never dropped).
4. **Respond:** `sumo forward` formats the intent into the harness's native schema (the `SCHEMAS`
   table above) and writes it to stdout in the harness's expected shape, within the harness hook timeout.

The per-harness translation (payload-in, native-schema-out) lives in the harness adapter (`05`),
invoked by `sumo forward` — thin, host-specific, logic-free, the same separation `bin/hook.js` and
`capture corpus forward` both prove.

> **Latency budget:** the `sumo forward`→daemon round-trip must fit inside the harness's hook timeout (it blocks
> the agent). The daemon is therefore a hard dependency for steering. The per-decision plugin timeout
> (~5s, `03`) must be < the harness hook timeout, with margin for the socket round-trip.

## Composition, fail policy, timeout

- **Composition:** multiple plugins' `before(action)` handlers run as the priority-ordered handler engine waterfall, ordered
 by `priority`, **most-restrictive-wins / bail-on-first-deny** (`03`). `deny` > `defer` > `ask` >
 `modify`(merged) > `inject`/`warn`(accumulated) > `allow`.
- **Fail policy:** **fail-OPEN for non-safety hooks, fail-CLOSED for hooks declaring `safety:true`**
  (Cursor's `failClosed` precedent). A hung/erroring safety hook denies; a non-safety one is skipped.
- **Timeout:** every decision is wrapped in the plugin engine's local timeout race (`03`), default ~5s, < harness hook timeout. A
  timeout is a fail-open/closed event per the hook's safety flag.
- **Redaction:** the raw harness payload is redacted before storage (`16`), preserving evidence
  (tool name, command shape) without secrets.

## Conformance

Per `CONVENTIONS.md`, the harness-adapter conformance suite (`05`) gains hook assertions: each declared
intent maps to the correct native schema (validated against the `SCHEMAS` shape per harness); an
unsupported intent degrades down the documented chain with a diagnostic (never silent); a stop-gate
blocks and the loop guard prevents re-block; an observation hook emits the right `07` event with a
`dedupe` key that collapses against the transcript source.

## Compatibility considerations

-   Re-verify OpenCode current hook mechanisms against a primary artifact. For Codex,
  finish the remaining budget-dependent tool/post/stop live hook chain on an account with available
  Codex quota.
-   Whether the per-harness native-schema translation invoked by `sumo forward` is
  generated into config per-install or shipped in the adapter package. Recommend the translation lives
  in the adapter (`05`) and `sumo forward` dispatches to it, so it always matches the installed harness.
-   The exact per-harness hook timeout values (sets the ceiling for the ~5s plugin
  decision budget + socket round-trip).
