# Campsite Rule Pressure Scenarios

These fixtures capture the concrete pressure cases this skill is meant to
govern. They live with the skill so the rule, its examples, and its regression
scenarios stay in one place.

## Purpose

The first version of the campsite hardening work needs a deterministic,
CI-friendly safety net before any scored AI evaluation exists. These fixtures
provide that baseline.

Each scenario records:

- the concrete failure mode
- the current rationalization we want to prevent
- the repo surfaces that should enforce the rule
- a noncompliant sample response
- a compliant sample response

The executable suite lives in this directory as `*.test.js` files. The repo runs
them through the root `test:skills` command so the rule, the fixtures, and the
deterministic checks stay owned by the skill they validate.

## Scenario Inventory

1. `unrelated-test-failure.json`
2. `local-bug-in-touched-file.json`
3. `todo-in-touched-surface.json`
4. `stale-doc-blocker.json`
5. `separate-concern-confluence-mock.json`
6. `dismissive-language-in-response.json`
7. `todo-instead-of-fixing.json`

## Acceptance Shape

For every scenario, the tests should prove three things:

1. The fixture is well-formed and points at real repo surfaces.
2. The current repo surfaces contain the required enforcement signals.
3. The bundled noncompliant sample fails the deterministic rubric, while the
   compliant sample passes.

This is not a full model-behavior guarantee. It is a deterministic regression
net for the repo surfaces and response patterns we explicitly care about.
