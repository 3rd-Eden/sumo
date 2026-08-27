# Copilot hook fixtures

Captured on 2026-06-30 from `@github/copilot-sdk@1.0.4` driving the npm-installed GitHub Copilot
CLI 1.0.65 with `enableFileHooks: true`.

Setup:

- Temporary git repository with `.github/hooks/sumo.json`.
- Hook command read stdin, appended the raw payload to `hook-captures.jsonl`, and for `preToolUse`
  returned `{"permissionDecision":"allow"}` so the shell command could continue.
- Prompt asked Copilot to run `printf copilot-hook-fixture > <temp>/tool.txt` through the `bash`
  tool.
- `permissionRequest` was captured in the same SDK/file-hook path with a command hook that returned
  `{"behavior":"deny","message":"captured permissionRequest deny fixture"}`; the target file was not
  written, proving the native deny round-trip.

Scrubbing:

- Native session id, temp paths, transcript path, and timestamps were replaced with stable values.
- Payload keys, value types, hook event names, tool name, and tool result shape are preserved.
