# opencode fixtures — provenance

Capture-first (CONVENTIONS §3f). These value-level scrubbed records come from real OpenCode SSE bus
events. OpenCode client version in the captures: `1.2.27`.

- **Surface:** the SSE read stream (spec 05). Each fixture is a wrapper
  `{schemaVersion, nativeEvent, normalizedEvent, payload}`; **only `payload`** is the native input the
  parser consumes; the captured wrapper's `normalizedEvent` is ignored.
- `stream/turn.jsonl` — `session.created`, `message.part.updated` (text part), `message.part.delta`
  (a streaming delta → passthrough), `message.updated`, `session.status`.
- `stream/tool.jsonl` — `message.part.updated` with `part.type === 'tool'` (callID/tool/state) →
  `session.tool`.

OpenCode has **no on-disk JSONL** (its store is SQLite), so `can = { stream: true, file: false }` and
there are no `file/` fixtures. Excluded: `tool.execute.before/after` and `file-edited`
fixtures — those are OpenCode's plugin-HOOK payloads (`{callID,sessionID,tool}`, no `{type,properties}`
envelope), a different surface (spec 12), not the SSE read stream.
