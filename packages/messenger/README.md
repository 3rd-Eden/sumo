# `sumo/messenger` — where work comes from, and where results go back

The messaging adapter **framework**. It answers one question: *where does work come from, and where do
results go back to?* A messenger turns an external medium such as GitHub, Slack, or Jira into
normalized `work` and routes replies, claims, and reviews back to it. The orchestration lives
elsewhere; the messenger surfaces work and exposes effectors, but does not decide what to do with
them.

Imported as `sumo/messenger`.

> **This package is medium-agnostic framework: the base + the contracts only.** A concrete adapter
> (the medium-specific code) ships as a **plugin** that extends `Messenger` and registers itself with
> `sumo.messenger(id, mctx => new Cls(mctx))`. The first adapter, GitHub, lives in
> [`plugins/github`](../../plugins/github/README.md).

---

## The contract

A messenger **is an adapter**: a class extending `Messenger`, declaring `id` / `can` / `config` as
instance props, covered by one parametrized conformance suite. The base owns the machinery; an author
writes only the short medium primitives.

```js
import { Messenger, ok } from 'sumo/messenger';

class MyMessenger extends Messenger {
  id = 'my-medium';
  can = { reply: true, claim: true, status: true, review: true, react: false, distributed: false };
  config = MyConfigSchema; // a zod schema (introspection; validated at the plugin boundary)

  async *work() { /* yield raw { externalId, title, body, kind, ext } items (ingress) */ }
  async say(ref, text) { /* post a message back; return ok() */ }
  async mark(ref, who) { /* who===undefined → read ClaimState · who → set · null → clear */ }
  // optional: status(ref,s) · review(ref,r) · react(ref,emoji)
  // distributed only: touch(ref,agent) · pulse(ref,kind,data) · pulses(ref)
}
```

### Primitives an author implements

| Primitive | Required? | Purpose |
|---|---|---|
| `*work()` | required | async generator yielding raw medium items (ingress / `read`) |
| `say(ref, text)` | required | post a message back to the item's thread |
| `mark(ref, who)` | required if `can.claim` | claim state — `undefined` read · `who` set · `null` clear |
| `status(ref, s)` | optional (`can.status`) | publish progress |
| `review(ref, r)` | optional (`can.review`) | publish a review result |
| `react(ref, emoji)` | optional (`can.react`) | react with an emoji |
| `touch(ref, agent)` | optional | bump claim liveness on the medium (heartbeat) |
| `pulse` / `pulses` | optional (`can.distributed`) | post / read proof-of-life markers |

## What the base owns (inherited, written once)

- **Ingress** (`ingress()`): drives `*work()`, validates each item, mints a deterministic stable id,
  dedupes (idempotent re-ingest via the `mctx.store` seen-set), builds the bound consumer `work`
  object (via `mctx.work`), emits `work.appeared`, and yields it. The plugin runtime fans each work
  onto the `on('work', …)` channel.
- **Claim lifecycle** (`claim`/`heartbeat`/`release`): best-effort optimistic — most media (GitHub
  included) have **no atomic CAS**, so claim posts a marker → settles → re-reads, and the medium's
  current claimant (returned by `mark`) decides. The base treats the `mark` read as an opaque
  `ClaimState`; claim history/expiry are the adapter's.
- **The claims mirror**: a write-through CACHE in `mctx.store` that also serves as a same-machine fast
  *negative* pre-check (a fresh sibling claim short-circuits to `heldBy` before hitting the medium). It
  can only deny, never authorize — the medium is the source of truth.
- **Event emission**: `work.*` / `messenger.*` onto the one event log via the daemon client
  (`mctx.db.append`, `source: 'messenger'`, `adapter: <id>`).
- **Redaction-on-egress, capability degradation** (`SUMO_CAP_UNSUPPORTED`, never silent/fake), and
  **proof-of-life plumbing** (gated `can.distributed`; the orchestrator triggers and supplies the
  health verdict).

## Conventions conformance

`claim` and fallible primitives return the shared `Result` (`{ ok, value }` | `{ ok, code, reason }`);
unsupported optionals degrade to `SUMO_CAP_UNSUPPORTED`. `work` items share the normalized + `ext`
envelope with harness events but are a distinct payload type. Primitives throw only for programmer
error; operational failures (e.g. a medium call) are `Result`s. Conformance runs against the **real**
medium.
