# `sumo/work` - first-party work-loop capabilities

`sumo/work` registers the first-party work-loop capabilities:

```text
work.detect -> work.claim -> work.run -> work.review -> work.release -> work.released
```

It is a small workflow layer over existing Sumo contracts. It reads messenger-produced `work.*`
events, reconstructs the recorded work reference, delegates medium operations back to the messenger
that produced the work, and uses daemon-hosted session control to spawn worker sessions.

The package is imported as `sumo/work`.

## Boundaries

This package does not own:

- work-source polling,
- marker parsing,
- claim trust rules,
- harness spawning internals,
- review policy beyond the minimum work-loop verdict.

Those live in messenger plugins, [messenger](../messenger/README.md),
[session](../session/README.md), and [orchestrator](../orchestrator/README.md).

## Event Model

The work loop reads events from the daemon event log:

| Event | Use |
|---|---|
| `work.appeared` | Defines an actionable work item |
| `work.claimed` | Records successful claim state |
| `work.run-started` | Links a work item to a worker session |
| `work.review-posted` | Records review output |
| `work.released` | Records completion/release |

The latest state is reconstructed from events in sequence order. The daemon remains the source of
truth for sessions and event history.

## Capabilities

All capabilities are registered on CLI, MCP, and programmatic surfaces.

### `work.detect`

Finds the next actionable work item or a requested `workRef`.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |
| `timeoutMs` | Optional wait budget |

Returns a scorer-style object with `pass`, `message`, and, when found, `workRef` and `work`.

### `work.claim`

Claims a work item through the messenger that owns the work source.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |
| `agent` | Optional claimant name |
| `timeoutMs` | Optional wait budget while finding work |

Returns `{ workRef, work, agent }` on success or a shared failure result when no work or suitable
messenger configuration is available.

### `work.run`

Spawns a Sumo worker session for a claimed or detected work item.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |
| `prompt` | Optional custom prompt; otherwise one is built from work title/body |
| `cwd` | Optional working directory; falls back to work cwd, invocation cwd, then process cwd |
| `harness` | Optional harness id |
| `model` | Optional exact model or portable tier |
| `reasoningEffort` | Optional reasoning effort |
| `timeoutMs` | Optional wait budget while finding work |

On spawn success it emits `work.run-started` and returns `{ workRef, work, sessionId }`.

### `work.review`

Waits for a worker session to reach a terminal state, then posts a minimal review through the owning
messenger when configured.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |
| `sessionId` | Optional worker session id; otherwise read from `work.run-started` |
| `verdict` | `pass` or `request-changes` |
| `text` | Optional review text |
| `timeoutMs` | Optional worker completion timeout |

Returns a scorer-style object with `pass`, `workRef`, and `message`.

### `work.release`

Releases a claimed work item through the owning messenger.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |
| `agent` | Optional releasing agent |
| `outcome` | Optional structured outcome |

Returns `{ workRef, released: true }` on success.

### `work.released`

Scores whether a work item has been released.

Inputs:

| Field | Meaning |
|---|---|
| `workRef` | Optional explicit work id |

Returns `pass: true` when the selected work item has a `work.released` event, or when no work was
available.

## Configuration

Enable a messenger plugin that emits `work.*` events and supports the medium operations your workflow
needs. `work.run` only needs a discovered work item and a runnable harness. `work.claim`,
`work.review`, and `work.release` also need the owning messenger to support claim, review, or release
effectors.

Messenger-specific setup belongs to the messenger plugin README.

## Usage

Run a worker session for a known work item:

```sh
sumo work.run --workRef work_01J2V6SPG3W9X84YTAK8G2QG6N --harness codex --json
```

`work.run` looks up the latest recorded work state, builds a prompt from the work title/body unless
you pass `--prompt`, spawns a Sumo session through the selected harness, emits `work.run-started`, and
returns the worker session id.

<details>
<summary>Example `work.run` output</summary>

```json
{
  "result": {
    "ok": true,
    "value": {
      "workRef": "work_01J2V6SPG3W9X84YTAK8G2QG6N",
      "work": {
        "id": "work_01J2V6SPG3W9X84YTAK8G2QG6N",
        "title": "Fix failing install reconciliation"
      },
      "sessionId": "ses_01J2V6SPG3W9X84YTAK8G2QG6N"
    }
  },
  "prints": [],
  "warnings": []
}
```

</details>

Over MCP, call `work.run` with the same structured fields: `workRef`, `prompt`, `cwd`, `harness`,
`model`, `reasoningEffort`, and `timeoutMs`.

## Related Docs

- [docs/events.md](../../docs/events.md)
- [session](../session/README.md)
- [messenger](../messenger/README.md)
