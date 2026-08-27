# Opportunistic Refactoring

Canonical source:
[Martin Fowler, "Opportunistic Refactoring"](https://martinfowler.com/bliki/OpportunisticRefactoring.html)

## Why This Matters Here

The campsite rule in this repo is a stricter operational version of the same
core idea: when you discover a real problem while already touching the surface,
do not use provenance or scope discomfort as a reason to leave it behind.

Fowler's article contributes three ideas that matter directly to this skill:

1. Small cleanup is part of normal implementation work, not a separate phase.
2. The right boundary is judgment, not total avoidance. Fix what is safe and
   local; do not disappear larger issues.
3. Tests are the safety net. Opportunistic cleanup is only responsible when the
   verification story stays honest.

## What This Skill Adds

`campsite-rule` adapts that idea to agent behavior, where the failure mode is
often silent dismissal rather than explicit refusal. The skill adds repo-
specific rules that Fowler's article does not cover:

- blocking verification is automatically part of the task
- "mention it later" is not enough
- discovered bugs still need real closure; only true external blockers bypass
- the owning repo skill still decides **how** the follow-up work is done

This reference exists so future edits can trace the name and philosophy back to
its canonical source instead of treating "campsite rule" as folklore.
