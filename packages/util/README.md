# `sumo/util`

Small shared production utilities used across multiple Sumo packages. This surface is intentionally
kept narrow: helpers belong here only when the same semantics are needed in more than one package.

Imported as `sumo/util`. Test-only helpers live in `sumo/util/testing`.

## API

| Export | Purpose |
|--------|---------|
| `isPlainObject(value)` | True for deep-mergeable record-like objects. |
| `sleep(ms)` | Resolve after a fixed delay. |
| `withDefined(target, fields)` | Copy only meaningful optional fields onto an existing object. |
| `defined(fields)` | Return a new object containing only meaningful optional fields. |
| `idAt(base, index)` | Build a stable child id when a parent id exists. |
| `textOf(content)` | Concatenate transcript text from a string or content-block array. |
| `tsMs(iso)` | Parse an ISO timestamp string to epoch milliseconds. |
| `timeoutRace(promise, timeoutMs, message?)` | Reject a promise if it does not settle before the timeout. |
| `cloneValue(value)` | Structured-clone JSON-ish data, with a shallow-copy fallback. |
| `canConnectSocket(sockPath)` | Check whether a Unix socket accepts a connection. |
| `waitUntil(predicate, options?)` | Poll an async predicate until it returns a truthy value or times out. |

## Testing helpers

`sumo/util/testing` exposes the real daemon-backed test helpers used across packages:

- `tempDir`
- `killDaemon`
- `openTempDb`
- `closeTempDb`
- `allEvents`
- `openTempLevelDb`
- `closeTempLevelDb`
- `sleep`

`waitUntil` now lives on the main `sumo/util` surface; it is not re-exported from `sumo/util/testing`.
