# Skills

Sumo uses skills in two related ways:

1. A repository skill that teaches agents how to use Sumo.
2. Plugin-declared skills that `sumo install` can copy into a project for agent use.

## The Sumo Skill

The Sumo skill lives at [skills/sumo/SKILL.md](../skills/sumo/SKILL.md).

It tells an agent how to:

- discover Sumo capabilities,
- spawn and resume sessions,
- use Sumo session ids correctly,
- wait for turns or session completion,
- read event output,
- respect harness lifecycle differences.

Install repository `3rd-Eden/sumo`, skill `sumo`, using the skill installer supported by the target
agent. For local development, the source is [skills/sumo/SKILL.md](../skills/sumo/SKILL.md).

## Plugin-Declared Skills

Plugins can declare agent skills through `sumo.install(...)`. During `sumo install --yes`, Sumo copies
declared skill files into:

```text
.agents/skills/<name>/SKILL.md
```

The roundtable plugin is an example. It declares a coordination skill so agents can announce intent
and inspect room state while multiple agents work in one repository.

See [plugin](../packages/plugin/README.md) for the `install` and `skill` verbs, and
[plugins/roundtable](../plugins/roundtable/README.md) for a plugin that installs a skill.

## Skills vs Capabilities

| Concept | Used by | Purpose |
|---|---|---|
| Skill file | Agent harnesses | Instructions an agent can read and follow |
| Plugin `skill(...)` verb | Sumo plugin runtime | Register a Sumo-level skill intent |
| Capability | CLI, MCP, programmatic callers | A structured operation with schemas and one `exec` |

The capability layer is documented in [capability](../packages/capability/README.md) and
[mcp](../packages/mcp/README.md).

## Agent Guidance

Agents using Sumo should:

- call `sumo commands` or inspect MCP tool schemas before guessing fields,
- pass Sumo session ids (`ses_...`) to session-control capabilities,
- use `session-native-id` only when resuming through a harness-native thread id,
- prefer `session-await-turn` and `session-await-ended` over polling raw state,
- read events to understand what happened before taking follow-up action.

<details>
<summary>Minimal Sumo session workflow for agents</summary>

```sh
sumo session-spawn --prompt "Do the task" --cwd /path/to/repo --harness codex --json
sumo session-await-turn --sessionId ses_... --json
sumo events --session ses_... --type session.message --json
sumo session-end --sessionId ses_... --json
sumo session-await-ended --sessionId ses_... --json
```

Example output shape:

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
