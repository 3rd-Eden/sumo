# Campsite Rule External Patterns

This file records the community skill patterns that
[`campsite-rule`](../SKILL.md) routes to or depends on. It is the audit trail
for external skill references so contributors can understand where those
workflows live and what happens when they are not installed.

## Adopted Patterns

| Source | Canonical link | Local use |
| --- | --- | --- |
| `systematic-debugging` | [`obra/superpowers`](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md) | Route runtime errors, unexpected behavior, and defects through Phase 1 (root cause investigation) before choosing between fix-now and durable-trace. Campsite-rule mandates investigation; `systematic-debugging` owns the investigation workflow. |

## How This Dependency Works

`campsite-rule` references `systematic-debugging` in five places:

1. **Quick Reference table** — routes errors/stack traces in verification output
2. **Step 2: Investigate before choosing an action** — mandates Phase 1 completion
3. **Step 3: Route To The Owning Skill** — routing table for runtime errors
4. **Red Flags** — "calling an error benign without reading source code"
5. **Rationalization Table** — "I will just add a TODO"

When `systematic-debugging` is installed (e.g. via `obra/superpowers`), the
agent follows its full Phase 1 workflow. When it is not installed, the agent
should still honor the intent: investigate before labeling severity, reproduce
before proposing fixes, and complete root-cause analysis before writing TODOs.

## External Adoption Rules

1. Do not cargo-cult whole upstream skills. Import only the specific pattern the
   repo needs, then state what was **not** imported.
2. If a community skill conflicts with repo-local hard gates such as
   `open-source-mindset`, `testing-standards`, or `documentation-standards`, the
   repo-local skill wins.
3. `campsite-rule` decides **whether** action is required. The external skill
   decides **how** that action must be performed.
