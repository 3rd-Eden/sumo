# Events

An event is one stored fact about something Sumo saw or did. Agent messages, tool calls, hook
callbacks, plugin activity, work-item updates, and transcript imports all become events in the same
daemon-owned log.

[db](../packages/db/README.md) stores and delivers the log. Package READMEs own the details
for the event producers: [hooks](../packages/hooks/README.md),
[session](../packages/session/README.md), [work](../packages/work/README.md),
[orchestrator](../packages/orchestrator/README.md), and
[plugin](../packages/plugin/README.md).

```text
agent / hook / plugin / work source
              |
              v
        Sumo daemon
              |
              v
    ordered event log: seq 1, seq 2, seq 3...
              |
              +-- sumo events
              +-- sumo tail
              +-- MCP tools
              +-- plugin listeners
```

## Event Envelope

Every event has the same outer shape:

```json
{
  "seq": 10231,
  "ts": 1718800050000,
  "type": "session.message",
  "source": "session",
  "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
  "adapter": "codex",
  "dedupe": "msg:abc123",
  "payload": {},
  "ext": {}
}
```

| Field | Meaning |
|---|---|
| `seq` | The event's position in the log. It is a daemon-assigned number, not a timestamp. |
| `ts` | Timestamp in milliseconds since the Unix epoch. |
| `type` | What happened, such as `session.message` or `work.claimed`. |
| `source` | Which Sumo surface produced it, such as `session`, `hook`, `plugin`, or `messenger`. |
| `sessionId` | The Sumo session id, when the event belongs to an agent session. |
| `adapter` | The harness or messenger adapter id, when one is involved. |
| `dedupe` | A stable identity used to merge the same fact from multiple sources. |
| `payload` | The normalized data most consumers should read. |
| `ext` | Extra adapter-specific data preserved for debugging or advanced integrations. |

## Core Event Families

| Family | Meaning |
|---|---|
| `session.*` | Agent session lifecycle, messages, tool calls, approvals, idle/stall/end/death. |
| `work.*` | Work intake, claim, run, review, status, release, and release confirmation. |
| `messenger.*` | Work-source coordination and proof-of-life events. |
| `plan.ingested`, `transcript.ingested`, `config.snapshot` | Imported files and snapshots discovered from agent artifacts. |
| `orchestrator.*` | Decisions or conditions surfaced by the sole actor. |
| plugin-defined names | Events emitted by plugins, normally with `source: "plugin"`. |
| `session.raw:<native>` | A native harness event Sumo preserved even though it did not normalize it yet. |

## Steering Actions Are Not Events

Plugin `before` handlers use action names, not event names:

| Action | Runs before |
|---|---|
| `tool` | A tool executes. |
| `prompt` | A prompt is submitted. |
| `finish` | A turn or session finishes. |

The hook layer maps native harness hook names into either stored observations or these decision
actions. For example, Claude Code `PostToolUse` is an observation that can become `session.tool`;
Claude Code `PreToolUse` is a decision point that maps to `before("tool")`.

## Reading Events

```sh
sumo events --type session.message
sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
sumo events --since 0 --json
sumo tail --type session.tool
```

`--since` takes an event sequence number. `--since 0` means "start after sequence 0", so it replays
all stored events before following new ones. `--since 120` means "start after event sequence 120";
it is not seconds or milliseconds.

<details>
<summary>Example `sumo events --type session.message --json` output</summary>

```json
[
  {
    "seq": 42,
    "ts": 1718800050000,
    "type": "session.message",
    "source": "session",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "adapter": "codex",
    "payload": {
      "role": "assistant",
      "text": "I found four package boundaries..."
    },
    "ext": {}
  }
]
```

</details>

<details>
<summary>Example `sumo tail --type session.tool` output</summary>

```jsonl
{"seq":43,"type":"session.tool","sessionId":"ses_01J2V6SPG3W9X84YTAK8G2QG6N","payload":{"tool":{"name":"Read"},"status":"completed"}}
{"seq":44,"type":"session.tool","sessionId":"ses_01J2V6SPG3W9X84YTAK8G2QG6N","payload":{"tool":{"name":"Shell"},"status":"completed"}}
```

</details>

Plugin authors observe events with:

```js
sumo.on('session.tool', async (event) => {
  await event.emit('my-plugin.tool-seen', { tool: event.payload.tool?.name });
});
```

## Adding Event Types

Prefer an existing type when it already describes the fact. Add a new type when the concept is new to
Sumo. Put adapter-specific detail in `ext`; do not create a new top-level event type just because one
harness used a different field name. Preserve unknown native events as `session.raw:<native>` instead
of dropping them.

<details>
<summary>Why dedupe matters</summary>

A live hook and a later transcript import can describe the same tool call. When both sources know a
natural id, they compute the same `dedupe` key. The daemon keeps one event and enriches it with data
from the second source, so readers see one complete fact instead of two partial records.

</details>
