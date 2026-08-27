# Agent Instructions

## Operating Rules

### Rule 0 — Package-First Implementation
Before every implementation, search for existing packages, libraries, or prior art that can do the job the same way, a slightly different way, or provide a foundation to build upon.

Prefer package code over project code. The best code in this project is code we do not have to maintain, so we can focus on Sumo's unique features instead of carrying underlying code burden.

Do not create custom code until package options have been checked and rejected for a specific reason. If a package can solve the problem well, use it. If a package can solve most of it, build the smallest Sumo-specific layer on top.

### Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

### Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

### Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

### Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

### Rule 5 — Act on Established Context
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue in user-facing messages. If you are weighing a choice, give a recommendation, not an exhaustive survey. This does not apply to thinking blocks.

### Rule 6 — Keep Scope Minimal
Don't add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup and a one-shot operation usually doesn't need a helper. Don't design for hypothetical future requirements: do the simplest thing that works well. Avoid premature abstraction and half-finished implementations. Don't add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.

### Rule 7 — Report Verified Outcomes
Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.

### Rule 8 — Continue With Available Context
You have ample context remaining. Do not stop, summarize, or suggest a new session on account of context limits. Continue the work.

## Before Development
- Read `docs/specs/conventions.md` and the relevant `docs/specs/*.md` before implementing a package or contract.
- If specs conflict, the most specific owning specification wins over the architecture overview.
- Search Cyberdyne for task-specific skills when starting a named workflow or unfamiliar domain. Install locally only when there is a clear, relevant match.
- Do not install broad workflow packs or global skills without a concrete need or user approval.

## Project Shape
- Package manager: pnpm workspace in `pnpm-workspace.yaml`.
- Source is plain ESM JavaScript with `.mjs` files. There is no TypeScript source and no build/transpile step.
- Runtime target is Node `>=22`, from `package.json#engines`.
- Code lives in `src/`, `packages/*/src/`, and `plugins/*/`.
- Do not edit `node_modules/` or generated package-manager state by hand.

## Commands
| Task | Command |
|------|---------|
| Install dependencies | `pnpm install` |
| Run all tests | `pnpm test` |
| Run one test file | `node --test path/to/file.test.mjs` |

## Code Conventions
- Use explicit `.mjs` extensions in relative imports.
- Use `node:` prefixes for built-in modules.
- Prefer named exports for modules that other code must introspect.
- Document public functions/classes with JSDoc typedefs, params, and returns.
- Use zod as the runtime contract at ownership boundaries: adapter to core, plugin config to plugin, socket message to daemon, hook payload to event log.
- Validate at system boundaries. Do not add defensive checks for impossible internal states or framework guarantees.
- Expected operational failures return the shared `Result` shape. Throw only for programmer errors or contract violations.

## Architecture Contracts
- Keep packages small and split by concern, not feature. Shared concerns belong in focused dependencies, not copied across packages.
- Preserve the unified adapter idiom: `id` / `can` / `config`, `read` / `write`, flat registration, common base machinery, zod contract, and conformance tests.
- Declare capabilities and degrade honestly. Never fake parity across harnesses or silently no-op unsupported behavior.
- Ingestion is lossless. Normalize additively, preserve adapter-specific data in `ext`, and surface passthrough events instead of dropping unknown records.
- The daemon is the sole LevelDB owner and event hub. Clients, hooks, MCP, CLI, plugins, and orchestrator surfaces go through daemon APIs.
- The orchestrator is the sole actor. Other packages are sensors and/or effectors; do not put workflow policy or business decisions in adapters.
- Install/config code must reconcile idempotently, preserve foreign config, mark Sumo-owned entries, and be reversible.

## Testing and Verification
- Add or update `node:test` tests when behavior changes.
- Use `node:assert/strict`; do not add an external test framework for 1.0 work.
- Test against the actual APIs, not mock APIs. Do not create fake API surfaces, fake clients, or parallel test-only contracts when the real API can be exercised.
- Do not mock, fake, stub, polyfill, monkey-patch, or override Sumo internals for the sake of testing. This includes fake harnesses, fake messengers, fake sessions, fake daemon clients, test-only provider registrations, and private/internal API access that bypasses what production code runs.
- `memory-level` is allowed for low-level tests of the Level-compatible storage abstraction. Use the real daemon and `classic-level` when testing daemon ownership, IPC, lifecycle, locking, cross-process behavior, or integrations.
- Reference implementations are allowed only when they are fully working, production-shaped components that could ship with Sumo. A reference plugin, messenger, adapter, or harness must provide real functionality through Sumo's public contracts, not exist only to trigger code paths.
- If an external boundary cannot be hit in the current environment, keep the real live test with a clear prerequisite skip or capture a real scrubbed fixture. Do not substitute an invented Sumo component. Any exception requires explicit maintainer sign-off.
- Adapter support requires captured, scrubbed real fixtures plus conformance tests. Handwritten mocks do not prove harness support.
- Coverage gates apply to source-scoped line, branch, and function coverage; all three must stay at or above 90%.
- After substantive edits, check lints/diagnostics for touched files and run the narrowest meaningful test command.
- If tests or lints cannot be run, state the reason and the residual risk.

## References
| Need | File |
|------|------|
| Cross-cutting engineering conventions | `docs/specs/conventions.md` |
| Storage and event log | `docs/specs/01-storage-and-eventing.md` |
| Daemon and IPC | `docs/specs/02-daemon-and-ipc.md` |
| Plugin runtime | `docs/specs/03-plugin-runtime.md` |
| Harness adapters | `docs/specs/05-harness-api.md` |
| Parser package | `docs/specs/08-jsonl-transcript-parser.md` |
| Orchestrator | `docs/specs/10-orchestrator.md` |
| Messenger adapters | `docs/specs/11-messenger-api.md` |
| Hooks and steering | `docs/specs/12-hooks-and-steering.md` |
| Installation lifecycle | `docs/specs/13-installation.md` |
| Capability layer + CLI/MCP interfaces | `docs/specs/16-interfaces-cli-mcp.md` |
