---
name: sumo
description: >-
  Use Sumo to orchestrate and observe AI coding sessions — spawn, verify, drive,
  resume, and inspect sessions (Claude Code, Codex, …) through its MCP tools or the
  `sumo` CLI. Use whenever a task involves running, steering, resuming, or inspecting
  coding sessions through Sumo.
when_to_use: >-
  When a task involves running, steering, resuming, or inspecting coding sessions
  through Sumo (CLI or MCP) — e.g. "spawn a session", "is it still running?",
  "resume that session", "what did that session do?", "watch the events".
allowed-tools: Bash(sumo:*)
model: sonnet
effort: medium
---

# Using Sumo

Sumo is a local **daemon** that owns AI coding **sessions** and an append-only **event log**. You don't run the coding agents yourself — you ask Sumo to spawn, drive, and observe them. Each session Sumo creates gets a **Sumo session id** (`ses_…`) that you use for every later call about it.

You drive Sumo through a catalog of **capabilities**, exposed on two surfaces:

- **MCP tools** — when you are connected to the Sumo MCP server. Each tool carries its own input schema; call them with structured args. Prefer this when available.
- **`sumo` CLI** — when you are in a shell, scripting, or doing a quick check. Form: `sumo <capability> --<field> <value>`, add `--json` for machine-readable output.

The `session-*` capabilities exist on **both** surfaces and hit the same implementation; the observe verbs (`sumo list/events/tail`) are CLI-only.

## Before you start

The daemon starts automatically on your first call — you don't start it or health-check it.

- **Discover exact schemas** instead of guessing fields: CLI `sumo commands` lists every capability and `sumo <capability> --help` shows its flags; over MCP, each tool advertises its input schema.
- **Working directory:** `session-spawn`/`session-resume` run in the `cwd` you pass, defaulting to the current directory. For a coding task, pass the target repo path explicitly.

## What every call returns

Results are **returned, not thrown** — there is always a value to inspect.

- **CLI (`--json`):** success prints `{ "ok": true, "value": <result> }`; operational failure prints `{ "ok": false, "code": "SUMO_…", "reason": "…" }`. Check `ok` first, then read `value`.
- **MCP:** success returns `<result>` directly as `structuredContent` (no `ok` wrapper). Operational failure comes back through the tool-call **error channel** (`isError`, with text `"SUMO_…: reason"`).

A check like `session-is-running` returns `{ pass, message }`: a failed check (`pass:false`) is still a *successful call*, not an error. Only genuine operational failures (e.g. a timeout) set `ok:false` / `isError`.

## Route: goal → capability

| You want to… | Capability |
|---|---|
| Start a new session | `session-spawn` |
| Check it started (and the model matches) | `session-is-running` |
| Wait for it to finish | `session-await-ended` |
| Send a follow-up turn | `session-send` then `session-await-turn` |
| Interrupt the current turn (keep the session) | `session-cancel` |
| Close the session | `session-end` |
| Resume it later | `session-native-id` then `session-resume` |
| Check it ended cleanly | `session-completed` |
| List / inspect / follow sessions | `sumo list`, `sumo events`, `sumo tail` |

## Capability reference

Required fields are marked `*`. `value` shows the success payload (inside the `{ ok:true, value }` envelope).

| Capability | Inputs | Returns (`value`) |
|---|---|---|
| `session-spawn` | `prompt*`, `cwd`, `harness`, `model`, `reasoningEffort` | `{ sessionId }` — a **new** `ses_…` |
| `session-resume` | `resumeId*` (native id), `prompt`, `cwd`, `harness`, `model`, `reasoningEffort` | `{ sessionId }` — a **new** `ses_…` continuing the prior native thread |
| `session-send` | `sessionId*`, `text*` | opaque ack — the turn is queued; confirm it landed with `session-await-turn` |
| `session-cancel` | `sessionId*` | opaque ack — idempotent; interrupts the turn, keeps the session |
| `session-end` | `sessionId*`, `force` | opaque ack — confirm teardown with `session-await-ended` |
| `session-is-running` | `sessionId*`, `expectModel` | `{ pass, message }` — `pass` when state is `running` **and** a model was recorded (and equals `expectModel` if given) |
| `session-completed` | `sessionId*` | `{ pass, message }` — `pass` when state is `ended` |
| `session-await-ended` | `sessionId*`, `timeoutMs`(=180000) | `{ sessionId, state }` (`ended`/`dead`), or `ok:false` on timeout |
| `session-await-turn` | `sessionId*`, `minAssistant`(=1), `timeoutMs`(=120000) | `{ sessionId, assistantMessages }`, or `ok:false` on timeout. `assistantMessages` is the **cumulative** assistant-turn count — to wait for the Nth send to land, set `minAssistant` to the running total (see W2) |
| `session-native-id` | `sessionId*` | `{ resumeId }` (the harness-native id), or `ok:false` if none recorded. Call after the session has run |

`harness` selects the backend (e.g. `claude-code`, `codex`); `model`/`reasoningEffort` are passed through to it — use values that backend accepts (`sumo <capability> --help` or the MCP schema list valid choices where constrained).

## The rules (read before you act)

- **Session-id spine.** Pass the **Sumo id (`ses_…`)** to every send / cancel / end / query / check. The **native harness id** is used *only* to resume, and you must read it at runtime via `session-native-id` (it returns `{ resumeId }`). Never hand-write a native id.
- **Harness kinds differ.**
  - *pipe* (`claude-code`) **self-exits** after its turn — just `session-await-ended`. Do **not** call `session-end`.
  - *server* (`codex`) **stays alive** — you **must** `session-end` then `session-await-ended`, or it hangs.
- **Server resume needs recorded work.** Codex can only resume a session that has at least one completed assistant turn on record. Before ending a `codex` session you intend to resume, `session-send` a prompt and wait for `session-await-turn` to succeed.
- **Use the checks, not raw state.** Ask `session-is-running` / `session-completed` rather than parsing a `state` field. States run `running` → `ended` (clean) or `dead` (crashed/killed). `session-await-ended` returns on **either** `ended` or `dead`, but `session-completed` only passes on `ended` — if `await-ended` reports `dead`, the session crashed; read its events instead of expecting `completed` to pass.
- **Event log watermark.** `sumo events`/`tail` take `--since <seq>`, **exclusive**. Omitting `--since` on `tail` is **live-only** (no backlog); `--since 0` replays everything. Filter with `--type` / `--session`. Each event has `seq`, `ts`, `type`, `sessionId`, `source`, `payload`; to see which `type` values are present, scan the output of `sumo events --json` (e.g. `session.message`).
- **Don't call `sumo forward` or `sumo mcp`.** `forward` is the internal hook tunnel; `mcp` is how an MCP client starts the server.

## Workflows

Every step is a real command (CLI shown; over MCP, call the same-named tool with the same `--flag`→field args). The goal is always: start work, let it run, **read the result**. `--json` gives you the `{ ok, value }` envelope to parse. Reuse the `ses_…` from the spawn output in every later call.

**W1 — One-shot task (`claude-code`, self-exits).**
```bash
sumo session-spawn --prompt "Add a dark-mode toggle" --harness claude-code --model claude-opus-4-8 --cwd /path/to/repo --json
#   → value carries the new sessionId, e.g. {"ok":true,"value":{"sessionId":"ses_…"}}
sumo session-await-ended --sessionId ses_… --json
#   → {"ok":true,"value":{"sessionId":"ses_…","state":"ended"}}   # "dead" = it crashed
sumo events --session ses_… --type session.message --json         # read what it produced
```
Do **not** call `session-end` here — a `claude-code` session exits on its own.

**W2 — Drive a long-lived session (`codex`, stays alive).**
```bash
sumo session-spawn --prompt "Refactor the auth module" --harness codex --model o3 --cwd /path/to/repo --json
# Each turn: send, then await it. await-turn's count is CUMULATIVE, so raise --minAssistant by 1 per send:
sumo session-send       --sessionId ses_… --text "Now add tests"
sumo session-await-turn --sessionId ses_… --minAssistant 1 --json
sumo session-send       --sessionId ses_… --text "Now update the docs"
sumo session-await-turn --sessionId ses_… --minAssistant 2 --json
#   → {"ok":true,"value":{"sessionId":"ses_…","assistantMessages":2}}  (timeout → {"ok":false,"code":"SUMO_VERIFY_FAILED",…})
sumo events --session ses_… --type session.message --json         # read replies any time
# A codex session does NOT self-exit — close it explicitly:
sumo session-end         --sessionId ses_… --json
sumo session-await-ended --sessionId ses_… --json
```

**W3 — Resume a previous session later.**
```bash
sumo session-native-id --sessionId ses_OLD --json
#   → {"ok":true,"value":{"resumeId":"<native harness id>"}}   (or ok:false if none was recorded)
sumo session-resume --resumeId <native harness id> --harness codex --model o3 --prompt "Continue" --cwd /path/to/repo --json
#   → value carries a NEW sessionId; use that for everything after
```
Resume takes the **native** `resumeId` (from `session-native-id`), not the `ses_…`, and returns a fresh `ses_…`. Pass `--cwd` again. To resume *again* later, send a turn and `session-await-turn` before ending — Codex can't resume a session with no recorded turn.

**W4 — Observe without controlling.**
```bash
sumo list --json                                       # sessions + their state
sumo events --session ses_… --type session.message --json   # what was said (filter --type; --since <seq> is exclusive)
sumo tail   --session ses_…                            # follow live (Ctrl-C to stop)
```

**Optional checks.** Not required to do work, but available: `sumo session-is-running --sessionId ses_… --expectModel <model> --json` returns `{ok:true,value:{pass,message}}` (`pass:false` is a normal result, not an error); `sumo session-completed --sessionId ses_… --json` confirms a clean `ended` state.
