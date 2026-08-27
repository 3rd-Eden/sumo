# `sumo/cli` - the `sumo` command

`sumo/cli` is the human and machine command-line surface for Sumo. It provides built-in commands for
database/session observation, daemon lifecycle, install reconciliation, hook forwarding, and MCP
serving. It also generates command-line subcommands from the runtime capability catalog.

The package is imported as `sumo/cli`. The binary is `sumo`.

## Command Model

There are two command families:

1. **Built-in infra verbs** owned by the CLI package.
2. **Generated capability commands** owned by packages or plugins and projected through
   `sumo/capability`.

Built-ins are registered directly with `commander`. Generated commands are created from
`runtime.capabilities()`: the capability name becomes the subcommand, and its zod input schema becomes
CLI flags.

## Built-in Commands

Source of truth: `sumo --help`.

| Command | Purpose |
|---|---|
| `sumo list` | List session documents from the daemon registry |
| `sumo events` | Query the event log |
| `sumo tail` | Live-follow the event stream |
| `sumo attach <sessionId>` | Attach via the harness's native interactive resume |
| `sumo daemon [status|start|stop|restart]` | Reflect or drive daemon lifecycle |
| `sumo commands` | List registered plugin/package capabilities and diagnostics |
| `sumo doctor` | Report config, plugin, install, and daemon health |
| `sumo forward <harness> <nativeEvent>` | Native hook entrypoint; payload is read from stdin |
| `sumo install [harness]` | Reconcile project setup or one harness's native hooks |
| `sumo uninstall [harness]` | Remove Sumo-owned project setup or hooks |
| `sumo mcp` | Serve generated MCP tools over stdio |

Global flags:

| Flag | Purpose |
|---|---|
| `--json` | Machine-readable output |
| `--config <path>` | Explicit config file path |

## Observation Commands

```sh
sumo list
sumo list --json
sumo events --session ses_...
sumo events --type session.message --since 0 --json
sumo tail --session ses_...
```

`events` and `tail` use the daemon event log. `tail` is live-only by default; `--since 0` replays the
log and then follows.

<details>
<summary>Example output</summary>

```json
[
  {
    "seq": 42,
    "type": "session.message",
    "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N",
    "payload": {
      "role": "assistant",
      "text": "Done."
    }
  }
]
```

</details>

## Daemon Commands

```sh
sumo daemon status
sumo daemon start
sumo daemon stop
sumo daemon restart
```

The daemon auto-starts for normal commands unless disabled with `SUMO_NO_AUTOSTART=1`. Explicit
daemon commands are useful for debugging or warming the daemon before hooks run.

<details>
<summary>Example output</summary>

```text
daemon: running
socket: /home/example/.sumo/sumo.sock
pid: 12345
```

</details>

## Install and Uninstall

```sh
sumo install --yes
sumo install codex --yes
sumo uninstall codex --yes
```

Without a harness argument, `install` reconciles project setup: MCP entries, plugin-declared skills,
and other Sumo-owned project wiring. With a harness argument, it performs narrow hook repair for that
harness. Installers preserve foreign config and mark Sumo-owned entries so uninstall removes only
Sumo-owned wiring.

Supported harness hook installers are `claude-code`, `codex`, `copilot`, and `cursor`.

<details>
<summary>Example output</summary>

```text
Sumo install
  MCP: configured
  skills: installed
  hooks:
    codex: configured

Done.
```

</details>

## Hook Forwarding

```sh
sumo forward <harness> <nativeEvent>
```

`forward` is written into native harness hook configs by install. It reads the native payload from
stdin and writes only the native response to stdout. Observation and diagnostics go to the daemon
event log. See [hooks](../hooks/README.md).

<details>
<summary>Example decision response shape</summary>

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

</details>

## Generated Capability Commands

Examples of first-party generated capabilities include:

| Capability | Owner |
|---|---|
| `sessions` | [session](../session/README.md) |
| `session-spawn` | [session](../session/README.md) |
| `session-send` | [session](../session/README.md) |
| `session-end` | [session](../session/README.md) |
| `session-resume` | [session](../session/README.md) |
| `session-await-turn` | [session](../session/README.md) |
| `harnesses` | [harness](../harness/README.md) |
| `models` | [harness](../harness/README.md) |
| `work.detect` through `work.released` | [work](../work/README.md) |
| `roundtable-room` | [plugins/roundtable](../../plugins/roundtable/README.md) |
| `opportunist-findings` | [plugins/opportunist](../../plugins/opportunist/README.md) |

Use:

```sh
sumo commands
sumo <capability> --help
```

to inspect the exact active catalog in a project.

<details>
<summary>Example output</summary>

```text
sessions
session-spawn
session-await-turn
session-end
harnesses
models
work.detect
work.claim
```

</details>

## Output Model

One renderer handles Sumo's shared result and diagnostic shapes.

- Successful operations exit `0`.
- Operational failures exit `1` and render a `SUMO_*` code.
- `--json` emits structured JSON and keeps stdout machine-readable.
- Capability commands invoked with `--json` buffer `ctx.print()` and `ctx.warn()` into the JSON
  envelope instead of interleaving text into stdout.

## MCP

```sh
sumo mcp
```

This starts [mcp](../mcp/README.md) over stdio. It exposes capabilities that declare the
`mcp` surface. Built-in CLI-only verbs such as `tail` remain CLI commands.

<details>
<summary>Example MCP client-visible tool names</summary>

```text
sessions
session-spawn
session-await-turn
harnesses
models
work.detect
```

</details>

## Development

```sh
node --test packages/cli/test/cli.test.mjs
node --test packages/cli/test/capabilities.test.mjs
```

The CLI tests exercise real Sumo paths with temp `SUMO_HOME` directories and real plugin runtimes.

## Module Map

| File | Responsibility |
|---|---|
| `src/cli.mjs` | Bin entrypoint |
| `src/index.mjs` | Command handlers and `commander` program |
| `src/capabilities.mjs` | Capability-to-CLI command generation |
| `src/install.mjs` | Install/doctor reconciliation helpers |
| `src/render.mjs` | Result, diagnostic, and table renderers |
| `src/daemon-host.mjs` | Steering-capable daemon host |
| `src/steer-host.mjs` | Project runtime host for hook/session control |
