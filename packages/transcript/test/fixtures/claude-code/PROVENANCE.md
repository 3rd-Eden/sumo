# claude-code fixtures — provenance

Capture-first (CONVENTIONS §3f / ). Real payloads, scrubbed value-level (`test/scrub.mjs`,
shape preserved), captured 2026-06-22.

- **Harness:** Claude Code `2.1.185`.
- `stream/turn.jsonl` — live `claude -p --output-format stream-json --verbose "Reply with exactly: HELLO"`
  in a throwaway temp cwd. Frames: `system/init`, `assistant`, `result/success`.
- `file/turn.jsonl` — the on-disk `~/.claude/projects/<enc>/<uuid>.jsonl` written by the SAME run
  (`user` + `assistant` records). This is the stream↔file dedup pair: the assistant `message.id`
  (`msg_bdrk_…`) is identical across both surfaces (the record `uuid` differs — do NOT dedup on it).
- `file/tools.jsonl` — `thinking`, `tool_use`, `tool_result` block records from a real prior session,
  reduced to the single relevant block each, scrubbed. Proves reasoning/tool normalization.
- `file/passthrough.jsonl` — `attachment`, `last-prompt`, `queue-operation` records (no normalized
  mapping → `session.raw:<native>`).
