# Observability

Sumo keeps one local record of agent activity: the daemon-owned event log. When you want to know what
an agent said, which tool ran, whether a hook blocked something, or what a plugin emitted, start from
the session id and read the log.

```text
                +----------------+
                |  Sumo daemon   |
                +-------+--------+
                        |
                        v
              ordered event log
        seq 41 -> seq 42 -> seq 43
          ^        ^         ^
          |        |         |
      session    hook     plugin
      message    result   event

Readers:
  sumo list      current sessions
  sumo events    stored events
  sumo tail      live event stream
  sumo mcp       MCP tools over the same capabilities
```

## Session Registry

Sessions are stored as documents whose ids start with `ses:`. Use the list commands when you do not
yet know the session id.

```sh
sumo list
sumo list --json
sumo sessions --json
```

`sumo list` is a built-in CLI read. `sessions` is a generated capability that can also be exposed
through MCP.

<details>
<summary>Example `sumo list --json` output</summary>

```json
[
  {
    "id": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "harness": "codex",
    "cwd": "/workspace/project",
    "state": "running",
    "updatedAt": 1783331400000
  }
]
```

</details>

## Event Log

```sh
sumo events
sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
sumo events --type session.message
sumo events --since 120 --json
```

`--since` is an event sequence number. Each event gets a daemon-assigned `seq`. `--since 120` means
"return events after event 120." It is not a session number, seconds, or milliseconds.

<details>
<summary>Example `sumo events --since 120 --json` output</summary>

```json
[
  {
    "seq": 121,
    "type": "session.tool",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "payload": {
      "tool": { "name": "Shell" },
      "status": "completed"
    }
  },
  {
    "seq": 122,
    "type": "session.message",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "payload": {
      "role": "assistant",
      "text": "The command completed successfully."
    }
  }
]
```

</details>

Follow live activity:

```sh
sumo tail --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
sumo tail --type session.tool
sumo tail --since 0
```

Without `--since`, `tail` shows only new events from the moment it starts. Use `--since 0` to replay
stored events and then keep following live events.

<details>
<summary>Example `sumo tail --type session.tool` output</summary>

```jsonl
{"seq":121,"type":"session.tool","sessionId":"ses_01J2V6SPG3W9X84YTAK8G2QG6N","payload":{"tool":{"name":"Shell"},"status":"completed"}}
{"seq":124,"type":"session.tool","sessionId":"ses_01J2V6SPG3W9X84YTAK8G2QG6N","payload":{"tool":{"name":"Read"},"status":"completed"}}
```

</details>

## What To Look For

| Question | Start with |
|---|---|
| What sessions exist? | `sumo list` or `sumo sessions --json` |
| What did an agent say? | `sumo events --type session.message --session <id>` |
| Which tools ran? | `sumo events --type session.tool --session <id>` |
| Did a hook block something? | Hook diagnostics and nearby `session.tool` events |
| Did a transcript get imported? | `transcript.ingested`, `plan.ingested`, and `config.snapshot` events |
| Did a work item move? | `work.appeared`, `work.claimed`, `work.run-started`, and `work.released` |
| What did plugins emit? | Plugin-namespaced event types with `source: "plugin"` |

See [docs/events.md](events.md) for the event vocabulary.

## Transcript and Artifact Ingestion

[transcript](../packages/transcript/README.md) parses native harness streams and transcript
files into events.

[agent-artifacts](../packages/agent-artifacts/README.md) finds on-disk artifacts, imports
transcripts, correlates native harness ids with Sumo session ids, and records plan/config snapshots.

The daemon merges duplicate facts by `dedupe` key. A live hook event and a later transcript event can
become one enriched event rather than two separate records.

## Hook Observability

Native harness hooks are forwarded through:

```sh
sumo forward <harness> <nativeEvent>
```

That command is written into harness config by `sumo install`; it is not a normal human workflow. It
reads the native hook JSON from stdin, sends decision hooks to Sumo's plugin waterfall, and records
observation hooks in the event log. [hooks](../packages/hooks/README.md) owns the hook
surface.

<details>
<summary>Example hook diagnostic event</summary>

```json
{
  "seq": 130,
  "type": "hook.diagnostic",
  "source": "hook",
  "adapter": "codex",
  "payload": {
    "nativeEvent": "PreToolUse",
    "code": "SUMO_HOOK_STEER_UNREACHABLE",
    "message": "steering was unavailable; non-safety hook failed open"
  }
}
```

</details>

## Agent Insight Workflow

1. Find the session with `sumo list --json`.
2. Read messages and tool events for that `sessionId`.
3. Check hook diagnostics when a tool was blocked, allowed unexpectedly, or missing.
4. Check transcript/artifact events when live output looks incomplete.
5. Check orchestrator and plugin events when Sumo changed the flow.
6. Use plugin commands for domain-specific state, such as `roundtable-room` or
   `opportunist-findings`.

<details>
<summary>Useful commands with expected shape</summary>

```sh
sumo list --json
# -> array of session documents

sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N --json
# -> array of event envelopes

sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N --type session.tool --json
# -> tool events for one session

sumo tail --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
# -> newline-delimited events as they arrive

sumo commands
# -> built-in and plugin-provided capability commands
```

</details>
