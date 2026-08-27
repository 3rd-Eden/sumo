# Contributing to Sumo

This repo is a pnpm workspace for a local-first agent orchestration system. Contributions should keep
the system package-owned, contract-driven, and honest about what each harness or integration can do.

## Repository Shape

- Source is plain ESM JavaScript with `.mjs` files.
- There is no TypeScript source and no build/transpile step.
- Runtime target is Node.js `>=22.13.0`.
- Package manager is pnpm.
- Code lives in `src/`, `packages/*/src/`, and `plugins/*/`.
- Package READMEs own package concepts; cross-package guides live in `docs/`.

## Package-First Rule

Before implementing custom code, search for an existing package, library, or prior-art implementation
that can do the job or provide a base. Prefer package code over project code when it fits. If a
package can solve most of the problem, build the smallest Sumo-specific layer on top.

Do not add a dependency casually. The search is required; adoption still needs a concrete reason.

## Documentation and Contract Sources

Package READMEs are the contributor entrypoint for package-owned behavior. Before changing a package
contract, read that package README, the neighboring package READMEs it links to, and the tests that
exercise the public API. If older internal design notes disagree with package READMEs or current
tests, update the package README and code together rather than adding a second public reference.

## Engineering Conventions

- Use explicit `.mjs` extensions in relative imports.
- Use `node:` prefixes for built-in modules.
- Prefer named exports for public modules.
- Document public functions and classes with JSDoc typedefs, params, and returns.
- Use zod at ownership boundaries: config, plugin inputs, socket messages, hook payloads, adapter
  output, and public capability schemas.
- Expected operational failures return the shared `Result` shape.
- Throw only for programmer errors or contract violations.
- Declare capabilities and degrade honestly; never fake parity across harnesses.
- Preserve adapter-specific data in `ext`; normalization is additive and lossless.
- Keep packages focused by concern, not feature.

## Testing

Run the narrowest meaningful verification for touched code, then broaden when the change crosses
package boundaries.

```sh
pnpm test
node --test path/to/file.test.mjs
```

Testing rules:

- Use `node:test` and `node:assert/strict`.
- Test against real APIs and real Sumo paths.
- Do not mock, fake, stub, monkey-patch, or override Sumo internals to bypass production code.
- Captured, scrubbed real fixtures are required for adapter support.
- `memory-level` is allowed for low-level storage abstraction tests.
- Use the real daemon and `classic-level` for daemon ownership, IPC, lifecycle, locking,
  cross-process behavior, and integrations.
- Source-scoped line, branch, and function coverage gates stay at or above 90%.

Documentation-only changes do not need tests. Inspect changed markdown for link correctness and stale
names.

## Documentation

- Root `README.md` is durable project positioning and navigation.
- Root `CONTRIBUTING.md` is the contributor entrypoint.
- Package READMEs are the primary developer reference for package-owned concepts.
- `docs/` contains cross-package learning paths, environment/error guides, and specs.
- Do not create a separate reference subtree for concepts that belong to packages.
- Use `<details>` for optional depth, examples, and schema-heavy material.

## Commands

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Run all tests | `pnpm test` |
| Run one test file | `node --test path/to/file.test.mjs` |
| Check CLI help | `node packages/cli/src/cli.mjs --help` |

## Git Hygiene

- Keep changes surgical.
- Do not reformat unrelated files.
- Do not edit `node_modules/` or generated package-manager state by hand.
- Preserve unrelated work in the tree.
