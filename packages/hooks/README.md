# `sumo/hooks` - native hook forwarding and observation

`sumo/hooks` is the shared layer behind `sumo forward <harness> <nativeEvent>`.

Harnesses such as Claude Code, Codex, Cursor, and Copilot can call a shell command when something
happens inside the agent. Sumo installs those commands with `sumo install`. When the harness fires a
hook, the command sends the native JSON payload to Sumo.

```text
harness native hook
        |
        v
sumo forward <harness> <nativeEvent>
        |
        v
sumo/hooks
        |
        +-- observation: store an event in the daemon log
        |
        +-- decision: ask plugins before the harness continues
```

The package is imported as `sumo/hooks`. The CLI command is documented in
[cli](../cli/README.md). Per-harness parsing belongs to [harness](../harness/README.md).

## Responsibilities

`sumo/hooks`:

- decides whether a native hook is an observation or a decision point,
- asks the harness adapter to translate native payloads,
- sends decision hooks to plugin `before(...)` handlers through the daemon,
- stores observation hooks in the event log,
- formats a Sumo decision back into the native response shape the harness expects,
- preserves unknown native events as raw passthrough events instead of dropping them.

It does not install hook config files, make workflow policy, or run plugin code in the hook process.

## Observation vs Decision

Observation hooks are facts. They tell Sumo something already happened, such as a tool finishing or a
session starting. They become events that readers can inspect with `sumo events` or `sumo tail`.

Decision hooks pause the harness before it continues. They let plugins allow, deny, or adjust a
specific action.

| Sumo action | Native moment | Plugin API |
|---|---|---|
| `tool` | Before a tool or shell command runs. | `sumo.before('tool', handler)` |
| `prompt` | Before a user prompt is submitted. | `sumo.before('prompt', handler)` |
| `finish` | Before an agent turn or session finishes. | `sumo.before('finish', handler)` |

## Forwarded Hooks

These tables describe the hook names Sumo installs or understands today. "Decision" means plugins can
intervene before the harness continues. "Observation" means Sumo records what happened. "Raw
passthrough" means Sumo preserves the native payload under a `session.raw:<harness>.<event>` type when
there is no normalized event yet.

### Claude Code

| Native hook | Sumo behavior | How it is used |
|---|---|---|
| `SessionStart` | Observation | Records that a Claude Code session started. |
| `PreToolUse` | Decision: `tool` | Lets plugins block or allow a tool before Claude Code runs it. |
| `PostToolUse` | Observation | Records the completed tool call and its output when available. |
| `UserPromptSubmit` | Decision: `prompt` | Lets plugins inspect a prompt before it reaches the agent. |
| `Stop` | Decision: `finish` | Lets plugins run finish checks before the turn/session stops. |
| `SubagentStop` | Decision: `finish` | Understood by the adapter when Claude-shaped payloads include it. |
| `Notification` | Observation | Preserved as an observation when emitted by the harness. |

`sumo install claude-code --yes` installs the primary Claude Code hooks: `SessionStart`,
`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`.

### Codex

| Native hook | Sumo behavior | How it is used |
|---|---|---|
| `SessionStart` | Observation | Records startup, resume, clear, or compact session starts. |
| `PreToolUse` | Decision: `tool` | Lets plugins block or allow a tool before Codex runs it. |
| `PermissionRequest` | Observation today | Preserved when emitted; plugin policy should use `PreToolUse` for tool decisions. |
| `PostToolUse` | Observation | Records completed tool use. |
| `PreCompact` | Raw passthrough | Preserved so consumers can see compaction activity. |
| `PostCompact` | Raw passthrough | Preserved after compaction activity. |
| `UserPromptSubmit` | Decision: `prompt` | Lets plugins inspect a prompt before it reaches Codex. |
| `SubagentStart` | Raw passthrough | Preserved when emitted. |
| `SubagentStop` | Raw passthrough | Preserved when emitted. |
| `Stop` | Decision: `finish` | Lets plugins run finish checks before Codex stops. |

`sumo install codex --yes` installs the documented Codex lifecycle hook set above and enables Codex
hooks when the local Codex configuration supports them.

### Cursor

| Native hook | Sumo behavior | How it is used |
|---|---|---|
| `sessionStart` | Observation | Records that a Cursor agent session started. |
| `beforeShellExecution` | Decision: `tool` | Lets plugins block or allow shell execution. |
| `beforeMCPExecution` | Decision: `tool` | Lets plugins block or allow MCP tool execution. |
| `afterShellExecution` | Observation | Records shell results. |
| `afterFileEdit` | Observation | Records file edits after Cursor applies them. |
| `preToolUse`, `postToolUse`, `postToolUseFailure` | Raw passthrough unless normalized later | Preserved if Cursor emits them in the current environment. |
| `subagentStart`, `subagentStop`, `sessionEnd`, `afterMCPExecution` | Raw passthrough unless normalized later | Preserved for inspection and future consumers. |
| `beforeReadFile`, `beforeTabFileRead`, `afterTabFileEdit` | Raw passthrough unless normalized later | Preserved when Cursor emits editor/file events. |
| `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought` | Raw passthrough unless normalized later | Preserved for prompt and response visibility. |
| `stop`, `preCompact`, `workspaceOpen` | Raw passthrough unless normalized later | Preserved for lifecycle visibility. |

Cursor's hook surface depends on the Cursor agent runtime. Some installed hook names may never fire in
a given Cursor mode.

### Copilot

| Native hook | Sumo behavior | How it is used |
|---|---|---|
| `sessionStart` / `SessionStart` | Observation | Records that a Copilot session started. |
| `sessionEnd` / `SessionEnd` | Observation | Records that a Copilot session ended. |
| `userPromptSubmitted` / `UserPromptSubmit` | Observation | Records submitted prompts. |
| `preToolUse` / `PreToolUse` | Decision: `tool` | Lets plugins block or allow a tool before Copilot runs it. |
| `permissionRequest` / `PermissionRequest` | Decision: `tool` | Lets plugins handle a permission-style tool gate. |
| `postToolUse` / `PostToolUse` | Observation | Records completed tool use. |
| `postToolUseFailure` / `PostToolUseFailure` | Observation | Records failed tool use. |
| `agentStop` / `Stop` | Decision: `finish` | Lets plugins run finish checks before the agent stops. |
| `subagentStart` / `SubagentStart` | Observation | Records subagent start. |
| `subagentStop` / `SubagentStop` | Decision: `finish` | Lets plugins run finish checks for subagent stop. |
| `errorOccurred` / `ErrorOccurred` | Observation | Records native Copilot errors. |
| `preCompact` / `PreCompact` | Observation | Records compaction start. |
| `notification` / `Notification` | Observation | Records native notifications. |

## How Hooks Show Up In Sumo

| Native activity | Sumo output |
|---|---|
| A normalized tool result arrives. | `session.tool` event. |
| A session starts. | `session.started` or the adapter's normalized session event. |
| A native event has no normalized shape yet. | `session.raw:<harness>.<nativeEvent>` event. |
| The hook payload cannot be parsed. | `hook.diagnostic` event and a non-zero hook command exit. |
| Steering is unavailable for a safety hook. | Native deny response, plus a diagnostic event. |
| Steering is unavailable for a non-safety hook. | Native allow/pass-through response, plus a diagnostic event. |

<details>
<summary>Example `sumo events --type session.tool --json` output from a hook</summary>

```json
[
  {
    "seq": 88,
    "type": "session.tool",
    "source": "hook",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "adapter": "claude-code",
    "payload": {
      "tool": { "name": "Read" },
      "status": "completed"
    },
    "ext": {
      "rawRef": "raw:01J2V6T7Y0P9H6YB9Y1ZC89Q7V"
    }
  }
]
```

</details>

## Safety Behavior

The install command can mark a forwarded hook as a safety hook. When Sumo cannot reach the daemon:

| Hook kind | Behavior |
|---|---|
| Safety hook | Fail closed. Return a native deny response to the harness. |
| Non-safety hook | Fail open. Let the harness continue and record a diagnostic. |

This keeps high-risk gates strict without making observational hooks break normal agent use.

<details>
<summary>Example deny response shape for a Claude-shaped `PreToolUse` safety hook</summary>

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Sumo steering unavailable - failing closed (safety hook)"
  }
}
```

</details>

## Dedupe and Raw Payloads

Hooks and transcripts can report the same fact. Sumo uses a dedupe key to keep one logical event:

- Tool calls with stable native ids can merge with transcript-sourced copies.
- Events without native ids get unique hook dedupe keys, so repeated callbacks remain separate facts.
- Raw native payloads are stored by `rawRef` and redacted by the daemon before persistence.

## API

```js
import { classify, forward, observe } from 'sumo/hooks';
```

| Export | Purpose |
|---|---|
| `classify(adapter, nativeEvent)` | Returns whether a native hook is an observation or decision. |
| `forward(args)` | Runs one forwarded hook over injected steering and observation effects. |
| `observe(args)` | Stores one observation hook as a normalized or passthrough event. |

`forward` takes injected effects so the CLI and tests can use the same path without making this
package own the daemon lifecycle.

## Related Docs

- [docs/events.md](../../docs/events.md)
- [harness](../harness/README.md)
- [cli](../cli/README.md)
