# cursor fixtures — provenance

Capture-first (CONVENTIONS §3f / ). Real payloads, scrubbed value-level, captured 2026-06-22.

- **Harness:** `cursor-agent 2026.06.19-…`.
- `stream/turn.jsonl` — live `cursor-agent -p --force --output-format stream-json "Reply with exactly:
  HELLO"` in a throwaway temp cwd. Frames: `system/init`, `user`, `assistant`, `result`. Cursor's
  stream-json mirrors Claude's `{type, message:{content[]}}` envelope. **Captured WITHOUT
  `--stream-partial-output` on purpose:** that flag makes Cursor emit additional partial assistant
  frames (deltas) with the same text and no distinguishing final marker, which — since Cursor messages
  carry no id — would double-ingest a single answer. The canonical read surface (what the harness
  adapter consumes) is the non-partial stream: one final assistant frame. Partial mode is out of scope
  for this parser (partials are deltas; there is no reliable per-frame final marker to split on).
- `file/turn.jsonl` — the on-disk `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` from the
  SAME run (`{role, message:{content[]}}`, no `type`).
- `file/tools.jsonl` — an assistant `tool_use` block record from a real prior session, scrubbed.

Dedup note: Cursor messages carry **no id** on either surface, and the on-disk text is query-wrapped
(`<user_query>…</user_query>`) and can diverge from the live text — so stream↔file do NOT collapse via
natural id or content hash. Surfaced in conformance; cross-source collapse for Cursor needs the
daemon/correlation layer (spec 09), not the parser.
