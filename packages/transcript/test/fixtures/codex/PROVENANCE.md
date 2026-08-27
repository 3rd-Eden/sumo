# codex fixtures — provenance

Capture-first (CONVENTIONS §3f / ). Real payloads, scrubbed value-level, captured 2026-06-22.

- **Harness:** `codex-cli 0.140.0`.
- `stream/turn.jsonl` — the **1.0 read surface** (spec 05): `codex app-server` JSON-RPC notifications,
  captured by driving `codex app-server --stdio` through `initialize` → `thread/start` →
  `turn/start "Reply with exactly: HELLO"`. Methods: `thread/started`, `turn/started`, `item/started`,
  `item/agentMessage/delta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`. (NOT
  `codex exec --json`/rollout `event_msg`, which is a different surface.)
- `stream/tool.jsonl` — an `item/completed` notification carrying a real `commandExecution` item
  (`/bin/zsh -lc 'echo …'`), captured from a `turn/start` that ran a shell command (sandbox
  `workspace-write`, `approvalPolicy: never`). Proves the live tool-item → `session.tool` mapping.
- `stream/usage-limit-error.jsonl` — real `codex app-server` JSON-RPC `error` and matching
 `turn/completed` failure notifications captured on 2026-06-28 when the Codex account hit a usage
 limit. It is retained here so stream-error classification remains fixture-backed.
- `file/turn.jsonl` — the on-disk `~/.codex/sessions/.../rollout-*.jsonl` from the SAME turn:
  `session_meta`, `response_item/message` (incl. assistant `output_text`), `response_item/reasoning`,
  `event_msg/task_complete`.
- `file/tools.jsonl` — `response_item/function_call` + `response_item/function_call_output` from a real
  prior rollout (they share `call_id`). Proves tool normalization.

Dedup note: tool calls share `call_id` across stream↔file (collapse works); plain assistant messages do
NOT share a natural id (stream `item.id` vs rollout response_item with no id) — surfaced in conformance.
`turn/*` (turn-level) and `thread/tokenUsage/updated` (usage) have no `07` home → passthrough.
