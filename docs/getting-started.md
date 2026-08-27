# Getting Started

This guide starts from the normal user experience: `sumo` is installed and available on your `PATH`.
You do not need to clone the Sumo repository to use Sumo in another project.

## Check the CLI

Run:

```sh
sumo --help
```

<details>
<summary>Example output</summary>

```text
Usage: sumo [options] [command]

Options:
  --config <path>       use a specific sumo.yml
  --json                print machine-readable JSON where supported
  -h, --help            display help for command

Commands:
  list [options]                             list sessions
  events [options]                           query the event log
  tail [options]                             live-follow the event stream (Ctrl-C to stop)
  attach [options] <sessionId>               attach to a session via its harness's native interactive resume
  daemon [options] [action]                  reflect daemon lifecycle
  commands [options]                         list registered plugin capabilities (+ diagnostics)
  doctor [options]                           config + plugin + daemon health
  forward [options] <harness> <nativeEvent>  native hook entrypoint (payload on stdin)
  install [harness]
  uninstall [harness]
  mcp
  help [command]
```

Generated capability commands, such as `session-spawn`, have their own help and are listed by
`sumo commands`.
</details>

## Add Config Only When You Need It

The minimal configuration is no configuration file. With no `sumo.yml`, Sumo uses its defaults and
the harnesses it can find on your machine.

Create `sumo.yml` in a project only when you want project-specific behavior:

```yaml
root: true

harness:
  default: codex
  fallback:
    - claude-code
    - cursor

use:
  - sumo/plugins/roundtable
```

What this does:

| Setting | Meaning |
|---|---|
| `root: true` | Stops parent-directory config files from changing this project. |
| `harness.default: codex` | Tries Codex first when a command needs to start an agent. |
| `harness.fallback` | Tries Claude Code, then Cursor, if the default harness is not available. |
| `use` | Enables plugins for this project. |

Configuration and environment variables are documented in [config](../packages/config/README.md).

## Reconcile Project Setup

From your project root, run:

```sh
sumo install --yes
```

This makes Sumo usable from your tools. Depending on your config and enabled plugins, it can add MCP
server entries, install plugin-declared agent skills, and write harness hook entries that call
`sumo forward`. Sumo marks the entries it owns, so running the command again should converge instead
of duplicating setup.

<details>
<summary>Example output</summary>

```text
Sumo install
  MCP: configured
  skills: roundtable installed
  hooks:
    codex: configured
    claude-code: already configured

Done.
```

</details>

Check the setup:

```sh
sumo doctor
```

<details>
<summary>Example output</summary>

```text
Sumo doctor
  config: /workspace/project/sumo.yml
  daemon: running
  database: /home/example/.sumo/sumo.db
  harnesses:
    codex: available
    claude-code: available
    cursor: unavailable - configure harness.cursor.bin
```

</details>

## Inspect What Sumo Can Do

Run:

```sh
sumo commands
sumo harnesses
sumo models
```

`sumo commands` lists capability commands from Sumo packages and enabled plugins. `sumo harnesses`
shows which agent runtimes Sumo can use. `sumo models` shows the model choices reported by those
harnesses.

<details>
<summary>Example output</summary>

```text
sessions
session-spawn
session-await-turn
session-end
events
work.detect
work.claim
work.run
roundtable-room
```

</details>

## Start an Agent Session

```sh
sumo session-spawn \
  --prompt "Inspect this project and summarize the package boundaries." \
  --cwd "$PWD" \
  --harness codex \
  --json
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

The `sessionId` is Sumo's stable id for the run. Use it to wait for the turn, inspect messages, and
end long-lived harness sessions.

```sh
sumo session-await-turn --sessionId ses_01J2V6SPG3W9X84YTAK8G2QG6N --json
sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N --type session.message --json
```

<details>
<summary>Example event output</summary>

```json
[
  {
    "seq": 42,
    "type": "session.message",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "payload": {
      "role": "assistant",
      "text": "This project is organized into package-owned modules..."
    }
  }
]
```

</details>

For a server-style harness such as Codex, end the session when you are done:

```sh
sumo session-end --sessionId ses_01J2V6SPG3W9X84YTAK8G2QG6N --json
sumo session-await-ended --sessionId ses_01J2V6SPG3W9X84YTAK8G2QG6N --json
```

<details>
<summary>Example output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
      "state": "ended"
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

For a one-shot harness such as Claude Code in its default mode, the process usually exits after the
turn; wait for it to end instead of sending an explicit end command.

## Observe the System

```sh
sumo list
sumo events --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
sumo tail --session ses_01J2V6SPG3W9X84YTAK8G2QG6N
```

<details>
<summary>Example output shape</summary>

```json
[
  {
    "seq": 42,
    "type": "session.message",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "payload": {
      "role": "assistant",
      "text": "I inspected the project."
    }
  }
]
```

</details>

Use [docs/observability.md](observability.md) for event-log, transcript, and agent-insight workflows.

## Use Sumo from an MCP Client

Configure the client to run:

```sh
sumo mcp
```

The MCP server exposes the same capability catalog as the CLI for capabilities that declare the MCP
surface. See [mcp](../packages/mcp/README.md).

<details>
<summary>Example client-visible tools</summary>

```text
sessions
session-spawn
session-await-turn
harnesses
models
work.detect
```

</details>

## Install the Sumo Agent Skill

For agents that support portable skills, install repository `3rd-Eden/sumo`, skill `sumo`, using that
agent's skill installer. The source lives at [skills/sumo/SKILL.md](../skills/sumo/SKILL.md), and the
skill workflow is documented in [docs/skills.md](skills.md).

<details>
<summary>Troubleshooting first setup</summary>

- `SUMO_CONFIG_NOT_FOUND`: an explicit `--config` or `SUMO_CONFIG` path does not exist. Fix the path
  or remove the override.
- `SUMO_NO_DAEMON`: run `sumo daemon start`, or unset `SUMO_NO_AUTOSTART`.
- No harnesses are available: run `sumo harnesses --json` and configure the relevant
  `harness.<id>.bin` value in `sumo.yml`.
- MCP tools are missing: run `sumo commands`; MCP tools are generated from registered capabilities.

See [docs/errors.md](errors.md) for stable `SUMO_*` error codes.
</details>
