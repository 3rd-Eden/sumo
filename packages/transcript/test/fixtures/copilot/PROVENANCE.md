# copilot fixtures — provenance

Capture-first (CONVENTIONS §3f / ). Real payloads, scrubbed value-level, captured 2026-06-29.

- **Runtime:** `GitHub Copilot CLI 1.0.65`
- **SDK:** `@github/copilot-sdk@1.0.4`
- `stream/turn.jsonl` — real live SDK events from a prompt-only session (`Reply with exactly: HELLO`),
  narrowed to the assistant `assistant.message` record plus the streamed `session.idle` passthrough.
- `stream/tool.jsonl` — real live SDK events from a session that ran `printf sumo-tool-capture` through
  the `bash` tool with SDK `approveAll`, narrowed to `tool.execution_start` +
  `tool.execution_complete`. Proves tool normalization from the live session surface.
- `stream/quota-error.jsonl` — real live SDK `session.error` captured on 2026-06-29 when the Copilot
  account returned a monthly quota exhaustion response (`errorType: quota`, `statusCode: 402`). Request
  identifiers are value-scrubbed; event shape and error taxonomy are preserved.
- `stream/permission-request.jsonl` — real live SDK `permission.requested` event captured on
  2026-06-30 from a session that asked Copilot to run `printf copilot-approved > <temp>/approval.txt`
  through the `bash` tool while Sumo held the permission request pending. `requestId`, `parentId`,
  `toolCallId`, and temp paths are value-scrubbed; the permission request shape is preserved. The same
  live capture was approved through `session.respondApproval({ decision:'accept' })`, and the command
  wrote the file.
- `file/turn.jsonl` — the persisted `~/.copilot/session-state/<id>/events.jsonl` from the SAME `HELLO`
  session, including `session.start`, `session.model_change`, `system.message`, `user.message`,
  `assistant.turn_start`, `assistant.message`, and `assistant.turn_end`.
- `file/tool.jsonl` — the persisted `events.jsonl` tool execution records from the SAME shell-tool
  session as `stream/tool.jsonl`; they share the real `toolCallId`.

Notes:

- Paths and long strings are scrubbed by `test/scrub.mjs`; keys and structure are preserved.
- On this Copilot build, `session.idle` was observed on the live SDK stream but was **not** present in
  the persisted `events.jsonl` capture, so only the stream fixture asserts that passthrough today.
