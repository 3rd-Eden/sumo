# Plugins

Plugins are the ecosystem layer of Sumo. They add policy, commands, skills, install declarations,
messenger adapters, harness providers, and workflow behavior without changing the core packages.

Core packages provide the shared machinery:

```text
events + daemon + config + capabilities
              |
              v
        plugin runtime
              |
              +-- observe events
              +-- steer agent actions
              +-- add CLI/MCP commands
              +-- spawn sessions
              +-- store plugin state
              +-- declare skills/install wiring
              +-- register providers
```

The runtime package reference is [plugin](../packages/plugin/README.md). This guide explains
how to build a useful plugin from a reader's first file to installable ecosystem behavior.

## What A Plugin Is

A plugin is a default-exported JavaScript function:

```js
export default function myPlugin(sumo, options) {
  // register behavior by calling sumo.* verbs
}

myPlugin.sumo = {
  name: 'my-plugin'
};
```

The function is called during runtime activation. It receives:

| Argument | Meaning |
|---|---|
| `sumo` | The plugin facade. Register events, commands, skills, stores, and providers here. |
| `options` | The plugin's validated config from `plugins.<id>` merged with inline options. |

The optional static `plugin.sumo` declaration lets Sumo know the plugin id, dependencies, and config
schema before the plugin body runs.

## Minimal Plugin

This plugin records whether a repository passed tests and blocks session finish until a pass is known.

```js
// sumo-plugin-test-gate/index.mjs
import { z } from 'zod';
import { create } from 'sumo/plugin';

export default function testGate(sumo, options) {
  const store = sumo.store('test-gate');

  sumo.on('test.finished', async (event) => {
    await store.set(event.payload.repo, {
      passed: event.payload.passed,
      command: event.payload.command,
      seenAt: Date.now()
    });
  });

  sumo.before('finish', async (event) => {
    const repo = event.payload.repo;
    if (!repo) return;

    const last = await store.get(repo);
    if (!last?.passed) {
      return { deny: `Run ${options.requiredCommand} before finishing.` };
    }
  }, { safety: true });

  sumo.command(create({
    name: 'test-gate-status',
    title: 'Test Gate Status',
    description: 'Read the last recorded test result for a repository.',
    inputSchema: z.object({
      repo: z.string().describe('Repository id')
    }),
    outputSchema: z.object({
      repo: z.string(),
      passed: z.boolean().optional(),
      command: z.string().optional(),
      seenAt: z.number().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    async exec(input) {
      const last = await store.get(input.repo);
      return { repo: input.repo, ...last };
    }
  }));
}

testGate.sumo = {
  name: 'test-gate',
  config: z.object({
    requiredCommand: z.string().default('pnpm test')
  }).default({ requiredCommand: 'pnpm test' })
};
```

What it demonstrates:

| Part | Purpose |
|---|---|
| `sumo.store('test-gate')` | Durable plugin-scoped state. |
| `sumo.on('test.finished', ...)` | Observe an event after it happened. |
| `sumo.before('finish', ...)` | Steer an agent decision before it completes. |
| `{ safety: true }` | Fail closed if steering is unavailable. |
| `sumo.command(create(...))` | Add one command to CLI, MCP, and programmatic callers. |
| `testGate.sumo.config` | Validate `plugins.test-gate` config before activation. |

## Loading A Plugin

Enable a plugin in `sumo.yml`:

```yaml
use:
  - ./sumo-plugin-test-gate/index.mjs

plugins:
  test-gate:
    requiredCommand: pnpm test
```

`use` entries are ordered. If a plugin declares dependencies in `plugin.sumo.plugins`, Sumo activates
those dependencies before the dependent plugin when they are available.

Inspect the active command surface:

```sh
sumo commands
sumo test-gate-status --repo 3rd-Eden/sumo --json
```

<details>
<summary>Example command output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "repo": "3rd-Eden/sumo",
      "passed": true,
      "command": "pnpm test",
      "seenAt": 1783331400000
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

## The Plugin Verbs

| Verb | Use when |
|---|---|
| `sumo.on(type, handler, opts?)` | You want to react after an event is stored. |
| `sumo.before(action, handler, opts?)` | You want to allow, deny, or adjust an action before a harness continues. |
| `sumo.command(...)` | You want to expose a structured operation through CLI, MCP, and code. |
| `sumo.store(namespace)` | You need durable plugin state. |
| `sumo.emit(type, payload, opts?)` | You need to add a plugin event to the shared log. |
| `sumo.run(prompt, opts?)` | You need to spawn an agent session. |
| `sumo.skill(name, fn, meta?)` | You want to register a Sumo-level skill intent. |
| `sumo.install(declaration)` | You want install-time setup such as agent skill files. |
| `sumo.use(plugin, opts?)` | You want to compose another plugin. |
| `sumo.destroy(handler)` | You need cleanup on runtime shutdown. |
| `sumo.harness(...)` / `sumo.messenger(...)` | You are registering a provider adapter. Most workflow plugins do not need these. |

## Observing Events

Use `on` for facts that already happened:

```js
sumo.on('session.tool', async (event) => {
  if (event.payload.tool?.name !== 'Shell') return;

  await event.emit('test-gate.shell-seen', {
    sessionId: event.sessionId,
    command: event.payload.tool?.input?.command
  });
});
```

`event.emit(...)` creates a plugin-sourced event with a stable dedupe key derived from the parent
event and payload. Replaying the same source event should not create duplicate derived facts.

Common event families are documented in [docs/events.md](events.md).

## Steering Agent Actions

Use `before` when the harness is paused and waiting for a decision:

```js
sumo.before('tool', async (event) => {
  const tool = event.payload.tool;
  const command = tool?.input?.command ?? '';

  if (tool?.name === 'Shell' && /\brm\s+-rf\s+\//.test(command)) {
    return { deny: 'Refusing to run a destructive root delete command.' };
  }
});
```

Supported steering actions:

| Action | Meaning |
|---|---|
| `tool` | Before a tool, shell command, or MCP tool executes. |
| `prompt` | Before a user prompt is submitted. |
| `finish` | Before an agent turn or session finishes. |

Return values:

| Return | Effect |
|---|---|
| `undefined` | Let the action continue unchanged. |
| `{ event: { ... } }` | Merge fields into the event for lower-priority handlers. |
| `{ deny: 'reason' }` | Stop the action. The harness adapter converts this into the native deny response. |

Use `{ safety: true }` for gates that should fail closed when steering cannot reach the daemon.

## Adding Commands

Commands are capabilities. Define them once, and Sumo projects them to CLI, MCP, and programmatic
callers.

```js
import { z } from 'zod';
import { create } from 'sumo/plugin';

sumo.command(create({
  name: 'repo-score',
  title: 'Repository Score',
  description: 'Score whether a repository is ready for release.',
  inputSchema: z.object({
    repo: z.string(),
    requireTests: z.boolean().default(true)
  }),
  outputSchema: z.object({
    pass: z.boolean(),
    message: z.string()
  }),
  surfaces: ['cli', 'mcp', 'programmatic'],
  async exec(input, ctx) {
    ctx.print?.(`checking ${input.repo}`);
    return {
      pass: true,
      message: input.requireTests ? 'tests recorded' : 'tests not required'
    };
  }
}));
```

Run it:

```sh
sumo repo-score --repo 3rd-Eden/sumo --requireTests --json
```

<details>
<summary>Example command output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "pass": true,
      "message": "tests recorded"
    }
  },
  "prints": [
    "checking 3rd-Eden/sumo"
  ],
  "warnings": []
}
```

</details>

Command design rules:

- Use zod schemas at the command boundary.
- Return plain data from `exec`; the runtime wraps successful values for each surface.
- Use `ctx.print` for human-facing progress text.
- Use `ctx.ask` only when the command can run interactively; MCP and headless surfaces return
  `SUMO_NO_INTERACTION`.
- Keep command names globally unique.

## Spawning Sessions

Use `sumo.run` when a plugin needs an agent to do work:

```js
sumo.command(create({
  name: 'triage-note',
  title: 'Triage Note',
  description: 'Spawn an agent to inspect a note and suggest next steps.',
  inputSchema: z.object({
    note: z.string(),
    cwd: z.string().optional()
  }),
  async exec(input) {
    const result = await sumo.run(`Triage this note and suggest next steps:\n\n${input.note}`, {
      cwd: input.cwd,
      harness: 'codex',
      model: 'balanced'
    });

    if (!result.ok) return result;

    return {
      sessionId: result.value.id
    };
  }
}));
```

Or run from a work item:

```js
sumo.on('work', async (work) => {
  const result = await sumo.run(`Investigate and resolve: ${work.title}`, {
    cwd: work.cwd,
    harness: 'codex',
    model: 'balanced'
  });

  if (!result.ok) {
    await work.emit('my-plugin.run-failed', {
      code: result.code,
      reason: result.reason
    });
    return;
  }

  await work.emit('my-plugin.run-started', {
    sessionId: result.value.id
  });
});
```

`sumo.run` returns a `Result<Session>`. Always handle the failure path; a project may have no
available harness, or a requested harness may not support the requested operation.

## Working With Work Items

Messenger adapters produce work and bind effectors to it. A workflow plugin should call the work
object it receives rather than importing the messenger adapter.

```js
sumo.on('work', async (work) => {
  const claimed = await work.claim();
  if (!claimed.ok) return;

  const prompt = `Work item: ${work.title ?? work.id}\n\n${work.body ?? ''}`;
  const session = await sumo.run(prompt, { cwd: work.cwd });
  if (!session.ok) {
    await work.reply(`Could not start an agent: ${session.reason}`);
    if (work.release) await work.release({ outcome: 'failed-to-start' });
    return;
  }

  await work.reply(`Started ${session.value.id}`);
});
```

That keeps workflow plugins medium-neutral. A GitHub issue, Slack thread, or future Jira ticket can
all become `work` with the same bound methods.

## Installing Skills And Project Wiring

Plugins can declare install-time requirements. `sumo install --yes` reconciles them and marks
Sumo-owned entries so uninstall can remove only what Sumo owns.

```js
export default function coordinator(sumo) {
  sumo.skill('coordinate-work', () => {}, {
    description: 'Coordinate with other agents before editing shared files.'
  });

  sumo.install({
    skills: [
      { name: 'coordinate-work', source: './skills/coordinate.md' }
    ]
  });
}

coordinator.sumo = { name: 'coordinator' };
```

Run:

```sh
sumo install --yes
```

<details>
<summary>Example install output</summary>

```text
installed: skill coordinate-work (/path/to/project/.agents/skills/coordinate-work/SKILL.md)
installed: MCP .mcp.json
installed: MCP .cursor/mcp.json
installed: MCP .codex/config.toml
```

</details>

## Registering A Provider

Most plugins consume events and commands. Provider plugins add a new adapter, such as a messenger for
a work source.

```js
import { Messenger } from 'sumo/messenger';

class AcmeMessenger extends Messenger {
  id = 'acme';
  can = { reply: true, claim: true, status: true, review: false, react: false, distributed: false };

  async *work() {
    // Yield raw work items from Acme.
  }

  async say(ref, text) {
    // Post text back to Acme.
  }

  async mark(ref, who) {
    // Read, set, or clear claim ownership.
  }
}

export default function acme(sumo, options) {
  sumo.messenger('acme', (context) => new AcmeMessenger({ ...context, config: options }));
}

acme.sumo = { name: 'acme' };
```

Provider plugins should keep medium behavior inside the adapter and workflow policy outside the
adapter. The messenger package owns the adapter contract:
[messenger](../packages/messenger/README.md).

## File Layout

A plugin can be a single file, but an installable plugin usually grows into this shape:

```text
sumo-plugin-test-gate/
  index.mjs
  package.json
  skills/
    test-gate.md
  README.md
```

Recommended `package.json` shape:

```json
{
  "name": "sumo-plugin-test-gate",
  "type": "module",
  "exports": {
    ".": "./index.mjs"
  },
  "peerDependencies": {
    "sumo": "*"
  }
}
```

Use a peer dependency for `sumo` so the host project owns the Sumo version.

## Lifecycle And Failure Behavior

Plugin activation is transactional. If a plugin throws during activation, Sumo rolls back the event
handlers, commands, skills, install declarations, and providers registered by that plugin.

Important behavior:

- Plugin config is validated before the plugin body runs.
- `destroy` handlers run in reverse activation order.
- Event delivery is at-least-once, so event handlers should be idempotent.
- `on` handlers run in parallel; return values are ignored.
- `before` handlers run as a priority waterfall; return values steer the decision.
- Expected operational failures should be returned as `Result` values by the surfaces that support
  them, not thrown.

## Plugin Checklist

Before shipping a plugin:

- Define `plugin.sumo.name`.
- Add a zod config schema when the plugin reads options.
- Keep workflow plugins medium-neutral; use bound `work` methods instead of importing a messenger.
- Keep provider plugins honest about `can` capabilities.
- Add commands with `create(...)` when they should reach CLI and MCP.
- Add example command output in the plugin README.
- Declare install-time skills or setup through `sumo.install(...)`; do not mutate user files during
  activation.
- Use `sumo.store(...)` for durable plugin state.
- Make event handlers idempotent because event delivery may replay after restart.
