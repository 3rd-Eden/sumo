# `roundtable` — cross-agent coordination plugin

A Sumo plugin that makes agents working in the same repository aware of each other. Agents join a shared room automatically, broadcast which files they are touching, and are gated on file collisions using first-come-first-serve locking so they never silently overwrite each other's work.

## What it does

| Capability | Mechanism |
|---|---|
| **Auto-join on start** | Listens for `session.started` events; adds the session to the room with its `cwd` and harness |
| **Auto-leave on close** | Listens for `session.ended` / `session.dead`; removes presence and releases file claims |
| **Passive file tracking** | Observes `session.tool` events; records which files each agent is actively editing |
| **FCFS file locking** | `before('tool')` gates write-class tools; first claimer proceeds, others are denied with a coaching message |
| **Pull-based room state** | `roundtable-room` MCP tool / CLI command returns live presence, claims, and recent announcements |
| **Explicit announcements** | `roundtable-announce` MCP tool / CLI command lets agents post intent to the room |
| **Boundary injection** | Injects a compact `[roundtable]` line at prompt boundaries when others are active or a collision is present (`changed-only` by default — only when state changed) |
| **Death probe** | On claim TTL expiry, pushes a liveness check to the suspected-dead holder before reclaiming |
| **Skill** | Installs `skills/announce.md` — encourages agents to announce intent and check the room when others are present |

## Requirements

All core primitives used (`sessionId` on the steer boundary, `{inject}` decision shape, `sumo.push`, `store.merge`, `sumo.emit`) are part of the Sumo core from which this plugin was developed. The plugin requires the steer-host runtime — it does not function in the standalone `sumo mcp` runtime, which is read-only for room state.

## Installation

Register in your project config:

```yaml
# sumo.yml
use:
  - sumo/plugins/roundtable
```

Or programmatically:

```js
import roundtable from 'sumo/plugins/roundtable';
sumo.use(roundtable);
```

## Configuration

All options have safe defaults and can be set in `sumo.yml` under `plugins.roundtable`:

```yaml
plugins:
  roundtable:
    enforce: true        # gate writes on collision (false = warn-only, always allow)
    claimTtlMs: 300000   # 5 min — a silent holder this old is treated as dead
    graceMs: 45000       # 45s grace window after TTL before reclaiming
    boundaryLine: changed-only  # or 'always' — when to inject the presence line
```

### `enforce`
When `true` (default), a write to a file held by another agent is **denied** with a coaching message. The agent can retry after the holder finishes. When `false`, the collision is noted via `{inject}` but the write is allowed — useful during rollout or in read-heavy workflows.

### `claimTtlMs`
How long a claim lives without any activity from the holder. The reaper checks every `claimTtlMs / 5`. Agents that go silent (crash, long test run, stuck) are probed then reclaimed after TTL + grace. Default 5 minutes reflects that agents rarely hold a single file for more than ~1 minute in practice.

### `graceMs`
After a claim TTL expires, a liveness probe is sent to the holder (when interactive/tmux). If the holder emits any event within `graceMs`, its claims are renewed. Silence past this window causes assume-dead reclaim.

### `boundaryLine`
`'changed-only'` (default) injects the presence/collision summary at `before('prompt')` only when the room state changed since the agent last saw it. `'always'` injects on every prompt boundary.

## MCP tools / CLI commands

Both tools are available on all surfaces: MCP, CLI, and programmatic.

### `roundtable-room`

Returns the current room state. No input required.

```json
{
  "presence": {
    "ses_01J...": { "harness": "claude-code", "cwd": "/work/myrepo", "lastSeen": 1234567890, "touchedFiles": ["src/auth.mjs"] }
  },
  "claims": {
    "/work/myrepo/src/auth.mjs": { "holder": "ses_01J...", "since": 1234567800 }
  },
  "messages": [
    { "text": "Refactoring auth module", "intent": "refactor", "sessionId": "ses_01J...", "ts": 1234567800 }
  ],
  "agentCount": 2
}
```

### `roundtable-announce`

Post an announcement to the room.

| Field | Type | Description |
|---|---|---|
| `message` | string (required) | The announcement text |
| `files` | string[] | Files you plan to touch |
| `intent` | string | Intent type: `"refactor"`, `"fix"`, `"add"`, etc. |
| `sessionId` | string | Sumo session id of the announcing agent |

Returns `{ ok: true, ts: <timestamp> }`.

## How agents interact

### Collision flow

1. Agent A edits `src/auth.mjs` — claim acquired, proceeds normally.
2. Agent B tries to edit `src/auth.mjs`:
   - **Denied** with inject: `[roundtable] 'auth.mjs' is held by agent <id> (claude-code). Use roundtable-room for status, roundtable-announce to coordinate. Retry shortly.`
   - Agent B can call `roundtable-room` to see status, `roundtable-announce` to coordinate, then retry.
3. Agent A finishes (session ends or goes inactive past TTL) — claim released.
4. Agent B's next write attempt succeeds.

### Multi-file (all-or-nothing)

If a refactor touches files A, B, C, and another agent holds B, the entire multi-file claim fails atomically. Files A and C are not partially claimed. Agent B is coached to retry after the holder releases.

### Path canonicalization

All file paths are normalized to `caseFold(path.resolve(cwd, raw))` before keying claims. Relative paths, `..` segments, and trailing slashes all resolve to the same canonical key. Case-folding is applied on case-insensitive filesystems (macOS) only.

### Files that cannot be locked

Directory/glob patterns, `rm -rf`, and tree-wide formatters cannot be enumerated cheaply. These tools degrade to warn-only — the boundary line notes the activity but no claim is placed. This is honest degradation, not a gap.

### Cursor

Cursor's file edits fire as `afterFileEdit` observations, not as `PreToolUse` gates. This means file edits from Cursor are passively tracked in `touchedFiles` and visible in the room state, but cannot be blocked. Cursor agents can still use `roundtable-room` / `roundtable-announce` to coordinate.

## Architecture notes

The claim registry is **in-process** on the steer-host runtime. Because all `before('tool')` hooks for a project funnel through a single runtime on one event loop, claim acquisition (`acquireAll`) is synchronous (no await before the decision) and therefore atomic by construction — no database compare-and-set is needed.

The room doc (`store('room')`) is a durable display projection written after each claim decision. It is used for crash recovery (after idle-eviction and reactivation) but is never the lock authority. The `roundtable-room` tool returns in-process state when the runtime has live sessions, falling back to the stored snapshot only on a freshly-reactivated runtime with no tracked sessions.

## Death handling

Claim release priority:
1. `session.ended` / `session.dead` event → immediate release
2. Any `session.*` activity refreshes the claim TTL
3. After `claimTtlMs` of silence: push a liveness probe (interactive sessions only), wait `graceMs` for any response, then assume-dead and reclaim

**Irreducible case**: an agent alive-but-silent inside a long-running tool (e.g. a 10-minute test) is indistinguishable from a dead one during the grace window. The next-boundary self-correction (`before('tool')` re-checks and tells the ex-holder it lost the file) prevents a *silent* double-write, but a single edit can land in the gap. With a 5-minute TTL, this scenario is near-theoretical in practice.
