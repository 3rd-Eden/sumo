# `sumo/session` - session contract and first-party capabilities

`sumo/session` owns the public session handle contract and registers first-party session capabilities.
It is mechanism only: no workflow policy, no messenger decisions, and no business logic.

The package is imported as `sumo/session`.

## Session Capabilities

`SessionCapabilities` is a zod schema for the frozen per-session capability descriptor computed by
the harness layer at spawn time.

```js
import { SessionCapabilities } from 'sumo/session';

SessionCapabilities.parse({
  canDeny: true,
  canSendKey: false,
  observationSource: 'event-stream',
  steeringVerified: false
});
```

Representative fields:

| Field | Meaning |
|---|---|
| `canDeny` | This session can block an action through steering |
| `canModifyInput` | This session can rewrite supported native inputs |
| `canInjectContext` | This session can inject context |
| `canAsk` | This session can ask a human through native machinery |
| `canDefer` | This session can defer/pause |
| `canApprove` | This session can respond to server-initiated approvals |
| `canCancel` | This session can interrupt active work |
| `canSendKey` | This session supports terminal key input |
| `canCapture` | This session supports screen capture |
| `observationSource` | Where Sumo expects clean observation data |
| `transcriptComplete` | Whether transcript capture is expected complete |
| `steeringVerified` | Whether Sumo-managed steering hooks were verified |

The schema is `.passthrough()` so adapter-specific capability details can survive without changing
the common contract.

## Session Handle

The `Session` typedef documents the handle returned by `sumo.run(...)` and built by
[harness](../harness/README.md). It exposes effectors such as `send`, `key`, `capture`,
`done`, `end`, and `respondApproval` where supported.

Consumers should treat Sumo session ids (`ses_...`) as the stable spine for Sumo APIs. Harness-native
ids are preserved for resume/correlation and should be read from Sumo, not guessed.

## Registered Capabilities

`register(sumo)` adds these capabilities to CLI, MCP, and programmatic surfaces.

| Capability | Purpose |
|---|---|
| `sessions` | List daemon `ses:` docs, optionally filtered by state |
| `session-spawn` | Spawn a daemon-owned session |
| `session-resume` | Resume by harness-native id and return a new Sumo session id |
| `session-send` | Send a text turn to a running session |
| `session-cancel` | Interrupt active work without ending the session |
| `session-end` | Gracefully or forcefully end a session |
| `session-is-running` | Scorer: session is running and model metadata is recorded |
| `session-await-ended` | Wait for `ended` or `dead` terminal state |
| `session-await-turn` | Wait for at least N assistant messages |
| `session-await-active-turn` | Wait for a live active turn event |
| `session-await-turn-completed` | Wait for a turn-completed event, optionally by turn id |
| `session-transcript-correlated` | Scorer: transcript path/native id correlation and dedupe collapse |
| `session-events-correlated` | Scorer: live events carry Sumo id and native id |
| `session-native-id` | Return `{ resumeId }` for later native resume |
| `session-completed` | Scorer: session ended cleanly |

Every capability calls the daemon session-control path. The daemon routes control to the live
orchestrator/session handle when one exists.

## Workflows

### Spawn and Wait

```sh
sumo session-spawn --prompt "Inspect this repo" --cwd "$PWD" --harness codex --json
sumo session-await-turn --sessionId ses_... --json
sumo events --session ses_... --type session.message --json
sumo session-end --sessionId ses_... --json
sumo session-await-ended --sessionId ses_... --json
```

<details>
<summary>Example output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
      "harness": "codex",
      "cwd": "/workspace/project"
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

### Resume

```sh
sumo session-native-id --sessionId ses_OLD --json
sumo session-resume --resumeId <native-id> --cwd "$PWD" --harness codex --prompt "Continue" --json
```

`session-resume` returns a new Sumo session id. Use the new `ses_...` for follow-up Sumo calls.

<details>
<summary>Example output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "sessionId": "ses_01J2V8GRJTX32X4HD0CYB3W2MT",
      "resumeId": "native-thread-id"
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

### Score a Journey

```sh
sumo session-is-running --sessionId ses_... --json
sumo session-events-correlated --sessionId ses_... --json
sumo session-completed --sessionId ses_... --json
```

Scorer capabilities return `{ pass, message }` inside `result.value` on the CLI JSON surface. A failed
score is a successful call with `pass: false`; it is not the same as an operational `Result` failure.

<details>
<summary>Example output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "pass": true,
      "message": "session ended cleanly"
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

## Dependency Graph

```text
sumo/capability  <-  sumo/session  ->  sumo/db
                         ^
                         |
                  sumo/harness builds handles
                  sumo/cli registers capabilities
```

## Development

```sh
node --test packages/session/test/session.test.mjs
```

Related package docs:

- [capability](../capability/README.md)
- [harness](../harness/README.md)
- [cli](../cli/README.md)
- [mcp](../mcp/README.md)
