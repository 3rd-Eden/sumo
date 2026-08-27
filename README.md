# Sumo

System for Unified Model Orchestration.

Sumo is a local-first orchestration kernel for AI coding agents. It wraps existing harnesses such as
Claude Code, Codex, Cursor, and Copilot instead of replacing them. A daemon owns the database and
event stream, adapters normalize what each harness or work source can do, and plugins provide policy
and workflow.

## Architecture

```text
CLI / MCP / native hooks
        |
        v
Sumo daemon  <---->  LevelDB event log and KV store
        |
        +-- harness adapters     Claude Code / Codex / Cursor / Copilot
        +-- messenger adapters   GitHub and future work sources
        +-- plugin runtime       on / before / command / skill / install
        +-- orchestrator         the sole actor for live session control
```

The important rule is: packages surface facts and effectors; the orchestrator acts. Harnesses,
hooks, messengers, transcripts, and artifacts all feed one event log. Workflow policy belongs in
plugins.

## Install

```sh
npm install -g sumo
sumo --help
```

Sumo requires Node.js `>=22.13.0`. `sumo install` reconciles project setup: it installs Sumo-managed
MCP entries, plugin-declared agent skills, and native harness hooks that forward to `sumo forward`.
Re-running it is expected.

## Learn

Start with these cross-package guides:

| Need | Document |
|---|---|
| First setup and first session | [docs/getting-started.md](docs/getting-started.md) |
| Configuration, `sumo.yml`, and environment | [config](packages/config/README.md) |
| Build plugins | [docs/plugins.md](docs/plugins.md) |
| Seeing what agents did | [docs/observability.md](docs/observability.md) |
| Event vocabulary and event consumers | [docs/events.md](docs/events.md) |
| Agent skills and the Sumo skill | [docs/skills.md](docs/skills.md) |
| Contributing to this repo | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Packages

Package READMEs are the primary reference for package-owned concepts.

| Package | Purpose |
|---|---|
| [db](packages/db/README.md) | Daemon-owned LevelDB storage, event log, subscriptions, search, TTL, and lifecycle |
| [config](packages/config/README.md) | `sumo.yml`, environment, and flag resolution |
| [plugin](packages/plugin/README.md) | Plugin runtime, verbs, lifecycle, store, capabilities, install declarations, and skills |
| [capability](packages/capability/README.md) | Define one capability and project it to CLI, MCP, and programmatic callers |
| [cli](packages/cli/README.md) | `sumo` command, built-in verbs, hook forwarding, install, and generated capability commands |
| [mcp](packages/mcp/README.md) | MCP server generated from the capability catalog |
| [harness](packages/harness/README.md) | Harness adapters for spawning, driving, and reading coding agents |
| [hooks](packages/hooks/README.md) | Native hook forwarding and observation ingestion behind `sumo forward` |
| [transcript](packages/transcript/README.md) | Harness transcript/frame parsing into normalized events |
| [agent-artifacts](packages/agent-artifacts/README.md) | On-disk transcript/artifact acquisition and correlation |
| [session](packages/session/README.md) | Session handle contract and first-party session capabilities |
| [work](packages/work/README.md) | First-party work-loop capabilities over messenger and session surfaces |
| [messenger](packages/messenger/README.md) | Adapter-neutral work intake and reply/claim/review primitives |
| [orchestrator](packages/orchestrator/README.md) | Event reactor and sole actor for live sessions |
| [error](packages/error/README.md) | Structured errors and stable `SUMO_*` codes |
| [log](packages/log/README.md) | Shared logging |
| [util](packages/util/README.md) | Small shared utilities and test helpers |

## Plugins

Plugins are how Sumo becomes an ecosystem. A plugin can observe events, steer actions, add CLI/MCP
commands, register skills, declare install-time wiring, spawn sessions, or provide new harness and
messenger adapters.

```js
import { z } from 'zod';
import { create } from 'sumo/plugin';

export default function testGate(sumo, options) {
  const store = sumo.store('test-gate');

  sumo.on('test.finished', async (event) => {
    await store.set(event.payload.repo, { passed: event.payload.passed });
  });

  sumo.before('finish', async (event) => {
    const repo = event.payload.repo;
    if (!repo) return;

    const last = await store.get(repo);
    if (!last?.passed) return { deny: `Run ${options.requiredCommand} before finishing.` };
  });

  sumo.command(create({
    name: 'test-gate-status',
    title: 'Test Gate Status',
    description: 'Read the last recorded test result.',
    inputSchema: z.object({ repo: z.string() }),
    exec: ({ repo }) => store.get(repo)
  }));
}

testGate.sumo = {
  name: 'test-gate',
  config: z.object({
    requiredCommand: z.string().default('pnpm test')
  }).default({ requiredCommand: 'pnpm test' })
};
```

Use [docs/plugins.md](docs/plugins.md) as the authoring guide and [plugin](packages/plugin/README.md)
as the runtime reference.

| Plugin | Purpose |
|---|---|
| [plugins/github](plugins/github/README.md) | GitHub messenger adapter for issue work, claims, review, and release markers |
| [plugins/roundtable](plugins/roundtable/README.md) | Cross-agent room, file claims, and coordination skill |
| [plugins/opportunist](plugins/opportunist/README.md) | Detects neglected findings and can spawn triage/repair sessions |
| [plugins/campsite-rule](plugins/campsite-rule/README.md) | Enforces resolution of dismissed findings and failed verification |

## Skills

The Sumo agent skill lives at [skills/sumo/SKILL.md](skills/sumo/SKILL.md). It teaches an agent how
to use Sumo's CLI/MCP session capabilities without guessing IDs, result shapes, or harness-specific
lifecycle rules.

The install target is repository `3rd-Eden/sumo`, skill `sumo`. For local development, the source is
[skills/sumo/SKILL.md](skills/sumo/SKILL.md); use the skill installer supported by the target agent.

## Development

```sh
pnpm test
node --test path/to/file.test.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository rules.

## License

[MIT](LICENSE)
