# Claude Code hook fixtures — provenance

Real captured native Claude Code hook payloads (the JSON Claude writes to a hook command's stdin),
used to verify the `claude-code` adapter's hook translation (`toNativeRequest` / `toNativeResponse`,
spec 12). Each file is the native `payload` object exactly as Claude emits it.

## Source

Recorded from real `claude` runs and scrubbed at the value level. Home paths are represented as
`$HOME`; the payloads contain no credentials.

| file | native event | captured | notes |
|------|--------------|----------|-------|
| `PreToolUse.json` | `PreToolUse` | 2026-03-30 | Bash tool call; `tool_name`/`tool_input`/`tool_use_id` |
| `Stop.json` | `Stop` | 2026-03-30 | `stop_hook_active:false`, `last_assistant_message` |

## Status (capture-first, §3f)
These prove the adapter's parse/format against the REAL payload shape. The end-to-end live round-trip
(install a hook → trigger `claude` → confirm the native response within the hook timeout) is performed
in Step 6's install-and-verify; until then, `claude-code` hook support is fixture-verified for the
parse/format contract, not yet live-verified end to end.

PostToolUse / UserPromptSubmit / SessionStart real payloads remain to be captured (Step 6).
