# `sumo/config` - configuration

`sumo/config` is the source of truth for how Sumo reads configuration. It answers three questions:

- Which `sumo.yml` files apply here?
- How do those files, environment variables, and flags combine?
- Which plugin options are valid before a plugin starts?

Most users only need a `sumo.yml` when they want to choose a default harness, enable plugins, or set
plugin options. If there is no config file, Sumo falls back to package defaults and whatever the
active command can infer.

## Where Config Comes From

Later sources override earlier sources:

```text
global config      ~/.sumo/sumo.yml
        |
        v
parent configs     sumo.yml files above the current project
        |
        v
project config     the nearest sumo.yml
        |
        v
environment        supported SUMO_* variables
        |
        v
CLI flags          command flags such as --config
```

The project search starts at the command's working directory and walks upward. It stops at the first
`sumo.yml` with `root: true`, at the git root, or at your home directory. The global config is always
read first when it exists.

`--config <path>` and `SUMO_CONFIG` point to an explicit config file. That file still layers on top
of global and parent configs unless it contains `root: true`.

## Minimal Setup

You do not need a config file for every command. The minimal setup is no config file at all. Create
`sumo.yml` only when you want project-local settings.

If you create an empty `sumo.yml`, leave it blank. A blank YAML file means "use defaults."

## Common Project Config

```yaml
root: true

harness:
  default: codex
  fallback:
    - claude-code
    - cursor

use:
  - sumo/plugins/roundtable
  - sumo/plugins/opportunist

plugins:
  roundtable:
    enforce: true
  opportunist:
    enabled: true
```

What each value does:

| Key | Meaning |
|---|---|
| `root: true` | Stop reading parent `sumo.yml` files above this one. The global config still applies. |
| `harness.default` | First harness Sumo tries when a command or plugin asks to start an agent. |
| `harness.fallback` | Ordered backup harnesses Sumo can try when the default is unavailable or fails in a fallback-safe way. |
| `use` | Ordered plugin list. Each entry is an importable plugin id or path. |
| `plugins.<id>` | Options passed to that plugin after validation by the plugin's own schema. |
| `plugins.roundtable.enforce` | Roundtable plugin option that controls whether file-claim collisions block writes. |
| `plugins.opportunist.enabled` | Opportunist plugin option that enables its finding detector. |

Harness-specific settings live under the harness id:

```yaml
harness:
  default: cursor
  cursor:
    bin: agent
  claude-code:
    bin: /opt/claude/claude
```

Use `harness.<id>.bin` for Claude Code and Cursor binary overrides. Codex and Copilot also support
their environment variable overrides listed below.

## Merge Rules

When several config files apply, Sumo combines them this way:

| Shape | Rule |
|---|---|
| Object | Deep-merge keys. Later values win when both files set the same leaf key. |
| Scalar | Replace. A later string, number, boolean, or null wins. |
| Array | Concatenate and remove duplicates, preserving first-seen order. |
| `use` | Same as arrays, plus a later `~name` removes an inherited plugin named `name`. |

Example:

```yaml
use:
  - sumo/plugins/roundtable
  - "~sumo/plugins/opportunist"
```

That keeps `roundtable` and disables an inherited `opportunist` plugin.

## Environment Variables

These are the Sumo-owned variables intended for users or operators:

| Variable | Scope | Purpose |
|---|---|---|
| `SUMO_HOME` | config, db, log, cli | Override the default Sumo home directory. Global config, daemon state, and logs live under this directory. |
| `SUMO_CONFIG` | config, cli | Explicit config file path. Equivalent to `--config`; CLI flags still win. |
| `SUMO_DB` | config, db | Override the daemon database path by setting `storage.path`. |
| `SUMO_NO_AUTOSTART` | db | When set to `1`, storage clients do not auto-start the daemon and return `SUMO_NO_DAEMON` instead. |
| `SUMO_LOG_LEVEL` | log | Set shared logger level. Defaults to `info`. |
| `SUMO_CODEX_BIN` | harness | Override the Codex binary used by the Codex harness. |
| `SUMO_COPILOT_BIN` | harness | Override the Copilot runtime or binary used by the Copilot harness. |

These variables are used internally by Sumo wiring:

| Variable | Scope | Purpose |
|---|---|---|
| `SUMO_DAEMON_MAIN` | db, cli | Override the daemon entrypoint used by storage autostart. The CLI uses this to start the steering-capable daemon. |
| `SUMO_IDLE_MS` | db, daemon | Override daemon idle shutdown in milliseconds. |
| `SUMO_SWEEP_MS` | db, daemon | Override daemon TTL sweep interval in milliseconds. |
| `SUMO_PROJECT_IDLE_MS` | cli daemon host | Override per-project runtime idle shutdown in milliseconds. |
| `SUMO_INGEST` | cli daemon host | Set to `0` to disable the agent-artifacts ingest service in the steering daemon host. |
| `SUMO_MANAGED` | install | Marker written into managed MCP entries so drift detection can identify Sumo-owned wiring. |

External harness variables such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `COPILOT_HOME` are owned by
their harnesses, not by Sumo. Use them according to the owning tool.

## Inspecting Configuration

Use `sumo doctor` to see whether config loaded, plugins validated, the daemon is reachable, and
install-managed hooks or MCP entries are current.

```sh
sumo doctor --json
```

<details>
<summary>Example output</summary>

```json
{
  "daemon": { "up": true },
  "harnesses": [
    { "id": "codex", "status": "available" },
    { "id": "cursor", "status": "unavailable", "reason": "backend binary not available" }
  ],
  "plugins": [
    { "plugin": "sumo/plugins/roundtable", "available": true }
  ],
  "diagnostics": []
}
```

</details>

List the active command/capability surface after config and plugins load:

```sh
sumo commands --json
```

<details>
<summary>Example output</summary>

```json
{
  "commands": [
    {
      "command": "session-spawn",
      "plugin": "",
      "title": "Session Spawn",
      "surfaces": "cli,mcp,programmatic",
      "hasSchema": true
    },
    {
      "command": "roundtable-room",
      "plugin": "sumo/plugins/roundtable",
      "title": "Roundtable Room",
      "surfaces": "cli,mcp,programmatic",
      "hasSchema": true
    }
  ],
  "diagnostics": []
}
```

</details>

## API

```js
import { resolve } from 'sumo/config';

const { config, diagnostics, plugins } = resolve({
  cwd: process.cwd(),
  flags: { config: undefined },
  env: process.env
});
```

| Export | Purpose |
|---|---|
| `resolve(input)` | Resolve config files, environment, and flags into `{ config, diagnostics, plugins }`. |
| `project(input)` | Discover and load the applicable project config chain. |
| `ConfigSchema` | Core zod schema for Sumo-owned config blocks. |
| `DiagnosticSchema` | Shape of config diagnostics returned to users. |
| `ErrorSchema` | Config-layer error code schema. |
| `sumoHome(env?)` | Resolve Sumo's home directory. |
| `globalConfigPath(env?)` | Resolve the global config path under the Sumo home. |
| `explicitConfigPath(flags, env, cwd?)` | Resolve an explicit config path from flags or env. |
| `applyEnv(config, env?)` | Apply supported environment overrides to a config object. |
| `DEFAULT_DAEMON_STARTUP_TIMEOUT_MS` | Shared default wait for daemon autostart socket readiness. |

## Diagnostics

Config problems are collected and returned instead of thrown one at a time.

| Code | Meaning |
|---|---|
| `SUMO_CONFIG_NOT_FOUND` | An explicit `--config` or `SUMO_CONFIG` path does not exist. |
| `SUMO_CONFIG_READ` | A config file exists but could not be read. |
| `SUMO_CONFIG_PARSE` | YAML failed to parse; the file is skipped. |
| `SUMO_CONFIG_INVALID` | A core block failed schema validation, or a file's root is not a mapping. |
| `SUMO_PLUGIN_CONFIG_INVALID` | An enabled plugin's options failed that plugin's schema. |

A missing `sumo.yml` during normal upward search is not an error. It simply means there is no config
layer at that directory.

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
node --test packages/config/test/resolve.test.mjs
```

### Module Map

| File | Responsibility |
|---|---|
| `src/index.mjs` | Public exports. |
| `src/resolve.mjs` | Resolve files, env, flags, schemas, and diagnostics. |
| `src/discover.mjs` | Find and parse config files. |
| `src/merge.mjs` | Merge config layers. |
| `src/env.mjs` | Resolve `SUMO_HOME`, `SUMO_CONFIG`, and `SUMO_DB`. |
| `src/plugins.mjs` | Validate plugin option slices. |
| `src/schema.mjs` | zod schemas and JSDoc typedefs. |
