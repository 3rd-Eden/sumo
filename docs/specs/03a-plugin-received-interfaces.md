# 03a — Plugin-Received Interfaces (the objects handed *into* a plugin)

> Companion to `03-plugin-runtime.md`. That doc covers the verbs a plugin calls *out* on `sumo`
> (`on`, `before`, `command`, `run`, `store`, `use`, `destroy`). This doc covers the objects handed
> *in* to a plugin — the work item, session handle, event, steering payload, command context — and
> the **bound, scoped methods each one carries**. This is the generalization of `scoped provider`'s
> `use(pattern, plugin)`: the layer that produces an object binds the right methods onto it, scoped
> to that object's origin, so the consumer never re-states scope and never names an adapter.

## The core idea: methods are bound onto the object, by the layer that made it

A workflow plugin calls `sumo.on('work', (work) => …)`. It does **not** call
`sumo.messenger('github').reply(...)`. Instead the **messenger adapter that produced the work**
binds `reply`/`claim`/`release`/etc. directly onto the `work` object, already pointed at the right
issue/thread/channel. The consumer calls `work.reply('done')` and the GitHub-ness (repo, issue
number, comment API, auth) is sealed inside the closure the adapter created.

This is how "github never surfaces" is enforced *mechanically*, not by convention: there is no
adapter handle for a consumer to reach, because the only thing they receive is the object with
methods already bound.

The same principle applies to every layer. Below is the full set, surface by surface.

---

## 1. Messenger layer → the `work` object (and `message`, `thread`)

Produced by a messenger adapter, handed to `sumo.on('work', fn)`. All methods are pre-bound to the
originating thread/issue and route back through the adapter that created it.

```js
/**
 * @typedef {Object} Work
 * // --- data (normalized, common across adapters) ---
 * @property {string} id            - Sumo work id (stable)
 * @property {string} title
 * @property {string} body
 * @property {string} [cwd]         - working dir hint, if the adapter knows it
 * @property {Record<string, unknown>} ext  - adapter-specific preserved fields
 * // --- bound methods (the adapter wired these to THIS work's origin) ---
 * @property {(text: string) => Promise<void>} reply         - post back to the originating thread
 * @property {() => Promise<ClaimResult>} claim              - claim this work (adapter-owned coordination)
 * @property {() => Promise<void>} heartbeat                 - prove liveness on the claim
 * @property {(outcome: object) => Promise<void>} release    - release/close the claim
 * @property {(status: object) => Promise<void>} status      - publish progress
 * @property {(review: object) => Promise<void>} review      - publish a review result
 * @property {() => Thread} thread                           - the message thread for follow-up
 */
```

What the consumer writes — no adapter named anywhere:

```js
sumo.on('work', async (work) => {
  const claim = await work.claim();          // adapter decides: GH label, Slack reaction, Jira transition
  if (!claim.ok) return;                     // someone else (or another local instance) holds it
  const session = await sumo.run(work.prompt);
  await session.done();
  await work.review({ passed: true, summary: 'tests green' });
  await work.release({ outcome: 'done' });
});
```

The `Thread` handed back by `work.thread()` carries its own bound methods for ongoing exchange:

```js
/**
 * @typedef {Object} Thread
 * @property {(text: string) => Promise<void>} send
 * @property {() => AsyncIterable<Message>} messages   - stream of replies on this thread
 * @property {(emoji: string) => Promise<void>} react  - no-op + diagnostic if adapter lacks reactions
 */
```

**Capability-aware, not faked:** if an adapter cannot do a method (Slack has reactions, email does
not), the bound method is still present but returns the shared failure `Result`
`{ ok:false, code:'SUMO_CAP_UNSUPPORTED', reason }` (surfaced as a diagnostic) rather than throwing
randomly or silently succeeding — identical to capability-failure on every other surface
(CONVENTIONS.md §3b, aligned #2). A plugin may check `work.can.react` etc. first. The set of `can.*`
flags is the adapter-neutral way to ask "is this supported here" without naming the adapter.

```js
/** @property {{ reply: boolean, claim: boolean, react: boolean, review: boolean, ... }} can */
```

---

## 2. Session layer → the `Session` handle

Returned by `sumo.run(prompt, opts?)`. Methods bound to the spawned session; backend kind (server vs
pipe, per `04-session-control.md`) is hidden. The consumer never knows if it's Claude over pipes or
OpenCode over HTTP.

```js
/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {SessionState} state    - starting|ready|working|awaiting_input|blocked|idle|stalled|ended|dead
 * @property {SessionCapabilities} capabilities  - per-session, verified at spawn (04-session-control.md)
 * // --- bound control methods ---
 * @property {(text: string) => Promise<void>} send       - prompt / stdin
 * @property {(key: string) => Promise<void>} key         - ArrowDown, Enter, C-c… (diagnostic if unsupported)
 * @property {(line: string) => Promise<void>} command    - slash command e.g. /mcp
 * @property {() => Promise<string>} capture              - current output/screen
 * @property {() => AsyncIterable<SessionEvent>} join      - observe this session's events
 * @property {() => Promise<void>} done                   - resolves when the session ends
 * @property {(opts?: { force?: boolean }) => Promise<void>} end  - graceful end vs kill
 * @property {(decision: object) => Promise<void>} [respondApproval]  - only on server backends w/ approvals
 */
```

`respondApproval` is **present only when the backend supports server-initiated approvals** (Codex
app-server, OpenCode); on pipe backends it is absent, and `session.capabilities.canApprove` is
`false`. This is the "declare, don't fake" rule applied to the session surface.

---

## 3. Event-stream layer → the `event` object (in `on`)

Handed to `sumo.on(type, fn)`. Read-mostly (observation can't block), but it carries bound helpers to
correlate and fetch related data without the plugin touching the daemon directly.

```js
/**
 * @typedef {Object} SumoEvent
 * @property {number} seq
 * @property {number} ts
 * @property {string} type           - normalized event type
 * @property {string} [sessionId]
 * @property {object} payload         - normalized fields
 * @property {object} ext             - adapter-specific preserved fields
 * // --- bound helpers ---
 * @property {() => Promise<Session|undefined>} session   - resolve the originating session, if any
 * @property {() => Promise<object|undefined>} raw        - the preserved raw adapter payload (redacted)
 * @property {(type: string, payload: object) => Promise<void>} emit  - emit a derived event (e.g. 'test:done')
 */
```

Example — an observer deriving a higher-level event:

```js
sumo.on('tool.post', async (e) => {
  if (e.payload.tool?.name === 'Bash' && /npm test/.test(e.payload.tool.command)) {
    await e.emit('test:done', { repo: e.payload.cwd, passed: e.payload.tool.exitCode === 0 });
  }
});
```

---

## 4. Steering layer → the steering `event` (in `before`)

Handed to `sumo.before(action, fn)`. Same normalized event, **plus** the bound capability descriptor
for the session it belongs to, so the plugin can write capability-aware steering. The *return value*
(not bound methods) is how steering acts — `{ deny }`, `{ event: {…} }`, or nothing — per the partial-object merge
merge contract in `03-plugin-runtime.md`.

```js
/**
 * @typedef {Object} SteerEvent
 * @property {string} action          - 'finish' | 'tool' | 'prompt' | ...
 * @property {object} payload
 * @property {object} ext
 * @property {SessionCapabilities} can - what THIS session can do (canDeny, canModifyInput, canAsk, canDefer…)
 * @property {() => Promise<object|undefined>} raw
 */
```

Capability-aware steering — degrade instead of failing where a harness can't honor the intent:

```js
sumo.before('tool', async (e) => {
  if (!isRisky(e.payload.tool)) return;            // pass through
  if (e.can.canDeny) return { deny: 'blocked: risky tool' };
  if (e.can.canInjectContext) return { event: { note: 'warning: risky tool' } };
  // else: nothing we can do on this harness — Sumo records a diagnostic automatically
});
```

The translation of `{ deny }` into the harness-native mechanism (Claude exit 2, Codex deny, OpenCode
throw, Cursor permission) happens in the adapter (`12-hooks-and-steering.md`) — the plugin never sees
it.

---

## 5. Command layer → the invocation `ctx` (in `command`)

Handed as the second arg to a `command` handler. Carries the parsed input plus bound helpers, and is
**identical whether the command was invoked via CLI, MCP, or programmatically** — the surface is
abstracted so one handler serves all three.

```js
/**
 * @typedef {Object} InvocationCtx
 * @property {'cli'|'mcp'|'programmatic'} surface   - where the call came from (for messaging only)
 * @property {(text: string) => void} print          - user-facing output (stdout on CLI, text block on MCP)
 * @property {(d: SumoDiagnostic) => void} warn       - structured diagnostic, rendered per surface
 * @property {(prompt: string, opts: object) => Promise<any>} ask  - prompt the human (interactive CLI; NACK+diagnostic on MCP/headless)
 */
```

```js
sumo.command('test-status', async ({ repo }, ctx) => {
  const r = await sumo.store('test-gate').get(repo);
  ctx.print(r?.passed ? '✅ passing' : '⚠️ not verified');
  return r;                                  // structured result for MCP/programmatic callers
});
```

`ctx.ask` is the cross-surface human-prompt: real on interactive CLI, a `SUMO_NO_INTERACTION`
diagnostic on MCP/headless. Declare-don't-fake again.

---

## 6. Store layer → the `store` handle (in `store(ns)`)

Returned by `sumo.store(ns)`. Bound to the plugin's own LevelDB sublevel (`kv:<ns>`); cannot address
another plugin's namespace.

```js
/**
 * @typedef {Object} Store
 * @property {(key: string) => Promise<any|undefined>} get
 * @property {(key: string, value: any, opts?: { ttlMs?: number }) => Promise<void>} set
 * @property {(key: string) => Promise<void>} del
 * @property {(prefix: string) => AsyncIterable<[string, any]>} scan
 * @property {(query: string, opts?: object) => Promise<SearchHit[]>} search  - over this namespace
 */
```

---

## 7. Provider-side: what an *adapter author* receives (rare path)

A messenger/harness adapter is contributed via `sumo.messenger(name, impl)` /
`sumo.harness(name, impl)`. This is the **other side** of surfaces 1–2: the adapter author's job is
precisely to *bind the methods* that surface 1/2 consumers will receive. The impl receives a small
builder so it can construct work/session objects with bound methods.

```js
// a messenger adapter — the ONLY place an adapter name/medium is known
sumo.messenger('github', (mctx) => ({
  async *ingress() {
    for await (const issue of pollLabeledIssues(mctx.config)) {
      // mctx.work(...) builds a normalized Work object and binds the methods
      // that surface-1 consumers will call. The bindings close over THIS issue.
      yield mctx.work({
        id: `gh_${issue.number}`,
        title: issue.title,
        body: issue.body,
        ext: { number: issue.number, repo: mctx.config.repo },
        reply:     (text)    => postComment(issue, text),
        claim:     ()        => addLabel(issue, 'sumo:claimed'),     // adapter-owned coordination
        heartbeat: ()        => touchComment(issue),
        release:   (outcome) => removeLabel(issue, 'sumo:claimed'),
        review:    (r)       => postReview(issue, r),
        can: { reply: true, claim: true, react: true, review: true }
      });
    }
  }
}));
```

So the binding happens **once, in the adapter**, scoped to each work item. Every downstream consumer
gets `work.reply` already pointed at the right issue. Swap the adapter to Slack and only this file
changes; every `on('work', …)` plugin is untouched. This is the scoped provider "hand the plugin
pre-bound, scoped verbs" pattern applied at the adapter boundary.

`mctx` (the adapter-build context) also carries `mctx.config` (the validated adapter config slice),
`mctx.store` (adapter-scoped kv for its coordination mirror), and `mctx.message(...)` /
`mctx.thread(...)` builders. The harness equivalent (`hctx`) carries `hctx.session(...)` to build a
`Session` with bound control methods over whichever backend the harness uses.

---

## Summary table — every received object and its bound surface

| Surface | Object received | Where | Bound methods (scoped by the producer) |
|---|---|---|---|
| Messenger | `work` | `on('work', fn)` | `reply`, `claim`, `heartbeat`, `release`, `status`, `review`, `thread`, `can.*` |
| Messenger | `thread` | `work.thread()` | `send`, `messages`, `react` |
| Session | `Session` | `await sumo.run(...)` | `send`, `key`, `command`, `capture`, `join`, `done`, `end`, `respondApproval?` |
| Event stream | `SumoEvent` | `on(type, fn)` | `session`, `raw`, `emit` |
| Steering | `SteerEvent` | `before(action, fn)` | `raw`, `can.*` (acts via return value) |
| Command | `InvocationCtx` | `command(name, fn)` 2nd arg | `print`, `warn`, `ask`, `surface` |
| Store | `Store` | `sumo.store(ns)` | `get`, `set`, `del`, `scan`, `search` |
| Adapter build (messenger) | `mctx` | `sumo.messenger(name, fn)` | `work`, `message`, `thread`, `config`, `store` (the producer binds the above) |
| Adapter build (harness) | `hctx` | `sumo.harness(name, fn)` | `session`, `config`, `store` |

**The invariant across all of them:** the producing layer binds methods onto the object, scoped to
that object's origin; the consuming plugin calls them without naming the adapter, the harness, the
session backend, or the medium. Unsupported methods are present-but-diagnostic (declare, don't fake),
queryable via `can.*`. This is what makes the universal plugin surface hold across four divergent
harnesses and many messengers.
