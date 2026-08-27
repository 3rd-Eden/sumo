---
name: Sumo
last_updated: 2026-06-28
---

# Sumo Strategy

## Target problem

Engineers using coding agents are forced to manage each harness as a separate, fragile runtime: context, decisions, transcripts, approvals, and handoffs live in different places and disappear across sessions. The hard part is not starting an agent; it is making agent work observable, steerable, recoverable, and reviewable enough that the engineer can drive less without accepting worse code.

## Our approach

Sumo wraps existing coding-agent harnesses instead of replacing them: local-first, engineer-run, adapter-backed, and normalized into one event stream owned by a daemon and acted on by an orchestrator. Workflow policy lives in plugins, so Sumo improves engineers through a flexible ecosystem rather than becoming a hosted platform or all-in-one agent harness.

## Who it's for

**Primary:** Engineers adopting AI coding agents - They're hiring Sumo to wrestle multiple coding agents into reliable engineering workflows: spawn, drive, observe, resume, coordinate, review, and learn from agent work across harnesses.

## Key metrics

- **End-to-end task success rate** - Percent of Sumo-managed tasks that reach a useful terminal state: completed, reviewed, merged, or explicitly handed back with a clear blocker; measured from the event log, messenger state, and PR/review outcomes.
- **Human intervention load** - Manual rescues per completed task: restarts, repeated steering, lost-context recovery, transcript digging, or "what happened?" investigations; measured from surfaced events, control commands, and handoff/recovery trails.
- **Cycle time to reviewed work** - Time from work intake or session spawn to reviewed output; measured from session, work, review, and PR lifecycle events.
- **Review/rework rate** - Rate of requested changes, broken tests, post-review fixes, or failed journeys after agent output; measured from review results, test outcomes, and follow-up work items.
- **Workflow coverage and provenance completeness** - Percent of core workflows with a complete trail: Sumo session id, native harness id, model, transcript/events, artifacts, claim/release/review state; measured from daemon records and journey assertions.

## Tracks

### Reliable agent control

Make Sumo-spawned sessions controllable, resumable, inspectable, and honest across Claude Code, Codex, Cursor, OpenCode, and future harnesses.

_Why it serves the approach:_ The product only works if engineers can trust Sumo to own the launch, know what the harness can really do, and degrade visibly when it cannot.

### Unified event spine

Keep the daemon-owned event log, normalized event catalog, dedupe/enrichment path, and orchestrator reactor as the kernel everything else uses.

_Why it serves the approach:_ One event stream is what turns separate harnesses, messages, transcripts, hooks, and artifacts into a coherent system the engineer can reason about.

### Workflow ecosystem

Build adapter-neutral workflow surfaces through plugins, messenger adapters, capabilities, CLI, MCP, and skills.

_Why it serves the approach:_ Workflow policy should be powerful and project-specific without being baked into the core or tied to GitHub, one harness, or one agent loop.

### Compounding operability and knowledge

Make setup, diagnostics, journeys, provenance, captured learnings, and knowledge retrieval part of the normal system.

_Why it serves the approach:_ Better agents are not just faster agents; they leave a trail, improve over repeated work, and make failures diagnosable instead of mysterious.

## Not working on

- Sumo is not trying to become a replacement agent harness that runs everything.
- Sumo is not building an all-in-one agent runtime.
- Sumo is not powering hosted agent platforms or a cloud control plane.
- Sumo stays narrowly focused on improving engineers who use coding agents through a local-first, flexible, powerful ecosystem.

## Marketing

**One-liner:** Sumo wrestles coding agents into disciplined engineering workflows without replacing the harnesses engineers already use.

**Key message:** Sumo is for engineers who want less manual driving and better code quality from their coding agents. It brings harnesses, events, workflow plugins, review loops, and knowledge capture into one local ecosystem so agent work becomes observable, steerable, recoverable, and improvable.
