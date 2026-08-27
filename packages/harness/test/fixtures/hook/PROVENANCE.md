# Hook fixtures — provenance and conformance status

Real captured native hook payloads (the JSON each harness writes to a hook command's stdin), used to
verify the adapters' hook translation (spec 12). Each file is the native `payload` exactly as the
harness emits it. Claude, Codex, and Cursor captures were recorded from real harness runs and scrubbed
at the value level. Copilot capture details live in `copilot/PROVENANCE.md`.

## Decision-steering parity (every harness verified from a PRIMARY artifact — never the matrix)

| harness | payloads | decision-RESPONSE schema (primary source) | live install-and-verify |
|---------|----------|--------------------------------------------|--------------------------|
| `claude-code` | ✅ real (`PreToolUse`, `Stop`) | ✅ campsite-rule (`permissionDecision` / Stop `block`) | ✅ **live** (`install-verify.live.test.mjs`) |
| `codex` | ✅ real (Claude-shaped: `SessionStart`, `UserPromptSubmit`, `PostToolUse`) | ✅ captured adapter behavior: PreToolUse `permissionDecision:'deny'`; Stop/UserPromptSubmit `decision:'block'`; shared code path with Claude (`hooks/claude-shaped.mjs`) | ✅ prompt hook live (`codex-install-verify.live.test.mjs`); tool/post/stop live chain remains budget-dependent |
| `cursor` | ✅ real (headless: `afterShellExecution`, …) | ✅ **Cursor official hook docs** (`beforeShellExecution` deny → `{permission:'deny', agent_message}`) | ✅ **live** (`cursor-install-verify.live.test.mjs`) |
| `copilot` | ✅ real (`sessionStart`, `userPromptSubmitted`, `preToolUse`, `permissionRequest`, `postToolUse`, `agentStop`) | ✅ Copilot SDK/file-hook payloads (`preToolUse` → top-level `permissionDecision`; `permissionRequest` → top-level `behavior:'deny'`; `agentStop` → top-level `decision:'block'`) | ✅ **live** (`live.test.mjs`: installed `.github/hooks/sumo.json` executes through SDK `enableFileHooks`) |
| `opencode` | parser exists (EventBus); harness adapter not built | OpenCode hooks are JS PLUGINS (throw-to-block), not command hooks — a different integration model | — (deferred: needs an OpenCode plugin + a spawn/transport adapter) |

Claude and Cursor are **live-verified** end to end (real binary → installed hook → `sumo forward` →
daemon → deny honored). Codex's project-local `.codex/hooks.json` path is live-verified on Codex
0.142 for `SessionStart` + `UserPromptSubmit`: real binary → installed hook → `sumo forward codex` →
daemon → plugin `before('prompt')` → native block honored. The remaining Codex live gap is the
budget-dependent tool/post/stop chain; keep that as a live prerequisite, not a synthetic hook run.
Copilot's repository file hooks are live-verified through the SDK-backed harness path; the
`permissionRequest` hook has a captured payload and native deny round-trip.

The captured headless-Cursor surface omits `beforeSubmitPrompt`, `afterAgentResponse`, and `stop` under
`cursor-agent -p`; the interactive stop gate therefore remains explicitly unmapped.
