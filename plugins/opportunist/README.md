# `sumo/plugins/opportunist`

`opportunist` watches Sumo's event log for issues an agent discovers but does not surface because
they sit outside the agent's original mission. It makes those findings discoverable through Sumo's
database-backed plugin store and uses orchestration to triage and optionally repair them without
interrupting the active parent session.

It is inspired by Martin Fowler's opportunistic refactoring framing: when an issue is discovered
while work is underway, handle it while the context is fresh. The plugin applies that idea through
Sumo's plugin ecosystem: detection happens from normalized events, triage happens after the parent
session reaches a stable point, and any repair happens in a separate guarded Sumo session.

## Enable

```yaml
use:
  - sumo/plugins/opportunist

plugins:
  opportunist:
    enabled: true
    harness: null
    tier: null
    model: null
    prompts:
      triage: null
      repair: null
```

All config fields are optional.

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | When false, commands remain available but events are ignored. |
| `harness` | `null` | Explicit triage/repair harness. `null` uses normal Sumo selection and fallback. |
| `tier` | `null` | Preferred portable model tier: `fast`, `balanced`, or `powerful`. |
| `model` | `null` | Optional exact model override. `tier` wins when both are configured. |
| `prompts.triage` | `null` | Optional path to a custom triage prompt template. |
| `prompts.repair` | `null` | Optional path to a custom repair prompt template. |

Prompt paths may be absolute or relative to the current Sumo process working directory. Templates use
`sumo/util`'s `renderTemplate` helper with single-brace variables such as `{findingsJson}`,
`{findingJson}`, `{recentTrace}`, `{parentSessionId}`, `{cwd}`, `{configJson}`, and `{sumo.cli}`.

## Behavior

- Observes `session.reasoning` and assistant `session.message` for dismissive scope language.
- Observes `session.tool` for verification failures when normalized command and exit status are
  available.
- Records findings in plugin-scoped storage and emits `opportunist.finding-detected`.
- Defers automation until `session.turn-completed`, `session.idle`, `session.ended`, or
  `session.dead`, so a parent agent can keep iterating and resolve its own temporary failures.
- Spawns a dedicated triage session with `sumo.run`; repair only starts when triage returns a
  `repair` decision and a repair prompt.
- Spawns a dedicated repair session with `sumo.run` when triage asks for one.
- Emits `opportunist.triage-started`.
- Emits `opportunist.repair-started`, `opportunist.repair-resolved`, or
  `opportunist.repair-inconclusive`.

The parent session is never prompted, blocked, or steered by this plugin.

Findings are stored in the plugin store returned by `sumo.store('findings')`:

- `finding:<id>` stores the finding, triage session id, repair session id, and resolution evidence.
- `recent:<sessionId>` stores a bounded recent-event buffer used to build triage and repair prompts.

## Commands

- `opportunist-findings` returns stored findings, optionally filtered by `state` or `sessionId`.
- `opportunist-resolve` manually resolves a finding with `{ id, status, evidence }`.

## Current Limits

- V1 uses the caller's cwd for triage and repair sessions. Workspace isolation is a separate Sumo
  capability.
- Harnesses differ in event coverage. If a harness does not emit reasoning text, the plugin can only
  use assistant messages and tool events.
- Detection is deterministic and intentionally narrow; it is not a general lint or review engine.

## Testing

- Deterministic runtime coverage lives in `plugins/opportunist/test/opportunist.test.mjs`.
- The real journey is live-gated in `plugins/opportunist/test/e2e-codex.live.test.mjs`: it creates a
  temporary Node project with an existing failing test, runs `sumo install`, drives a real Codex
  parent agent to make a feature change, verifies Sumo can tail the database output, then verifies
  opportunist records the finding, starts a separate triage session after the parent turn, and starts
  a separate repair session that fixes the issue.
