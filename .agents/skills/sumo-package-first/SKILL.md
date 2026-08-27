---
name: sumo-package-first
description: Use when implementing Sumo code, especially when adding helpers, lifecycle polling, filesystem/process utilities, Result handling, config merging, event-log access, or cross-package behavior. Prevents duplicating existing Sumo package utilities by requiring a local package/API search first.
---

# Sumo Package-First

Before adding any helper or local utility, search for an existing Sumo API.

## Required Search

Run targeted searches before writing the helper:

```bash
rg "export function|export async function|export const|export class" packages src plugins -g "*.mjs"
rg "<helper-name>|<behavior-keyword>" packages src plugins docs/specs -g "*.mjs" -g "*.md"
```

Prefer these existing surfaces when they fit:

- `sumo/util`: `sleep`, `waitUntil`, `canConnectSocket`, `timeoutRace`, `cloneValue`, `isPlainObject`, optional-field helpers.
- `sumo/util/testing`: temp daemon/database and test lifecycle helpers.
- `sumo/db`: daemon ownership, event log, keyspace, shutdown/control APIs.
- `sumo/error`: shared Result/Error shape and documented `SUMO_*` codes.
- `sumo/config`: config loading, validation, and merge semantics.

## Decision Rule

Use the existing package helper when semantics match. If you still add a new helper, state why no existing Sumo helper fits in the implementation notes or code review response.

Do not add package-local copies of generic lifecycle helpers such as `sleep`, retry loops, socket probes, object-shape checks, Result wrappers, or config merge logic.
