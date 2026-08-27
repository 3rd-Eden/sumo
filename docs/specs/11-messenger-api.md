# 11 — Messenger API

## What the messaging layer is

It answers one question: **where does work come from, and where do results go back to?** It separates
two things the reference implementation fused:

- **Orchestration** = deciding what agent work happens, running sessions, coordinating reviews →
  Sumo core + workflow plugins.
- **Messaging** = the medium carrying work in and status out (GitHub, Slack, Jira, email, MCP
  threads) → a **messenger adapter**.

A workflow plugin (issue → agent → PR → review) is written **once** against normalized concepts and
runs over any messenger, because the adapter translates between the external system and those
concepts. **GitHub is the first adapter, never the hidden contract.**

## Three separated concerns (the fix for "hacked-together scripts")

An earlier draft collapsed everything into a closure that dumped inline functions onto a `work`
object — no contract, no shared machinery, no separation. The correct design splits three concerns:

1. **The contract** — the capabilities every messenger may provide. Explicit, discoverable, zod-validated.
2. **The shared machinery** — claim TTL/heartbeat, the local daemon-store mirror, stable-id minting,
   event emission, redaction-on-egress, capability degradation. **Inherited, written once.**
3. **The medium-specific code** — the only thing a developer writes: how to list items, post a
   message, mark a claim. Small, focused, no lifecycle logic.

## Authoring: extend `sumo/messenger`, override primitives

> **Shared pattern (CONVENTIONS.md §3a):** `sumo/messenger` extends the common `sumo/adapter` base,
> so a messenger is the same shape as a harness — `id`/`can`/`config` props, flat registration,
> shared eventing/dedup/redaction, one conformance suite. The messenger's primitives are the common
> **`read`/`write`** duality wearing domain names: `*work()` is the messenger's `read` (ingest), and
> `say`/`mark`/`status`/`review` are its `write` variants (act). They dispatch through the same base
> machinery as a harness's `read`/`write` — not a second mechanism. Keep the domain names (`work`
> reads better than `read` for "work items"), but know they are specializations, not a new idiom.

A developer **extends a Sumo-provided base class** and overrides a small set of short medium
primitives. The base owns all lifecycle. This is the one place `extends` appears in a developer's
world (everything else is functions/verbs); a class earns its keep here because there is genuinely
shared machinery to inherit and a contract to enforce.

```js
import { Messenger } from 'sumo/messenger';
import { z } from 'zod';

export class GitHubMessenger extends Messenger {
  static id  = 'github';
  // declare what this medium can do — drives work.can.* and degradation. Same word
  // ('can') on author side and consumer side (work.can.*).
  static can = { reply: true, claim: true, status: true, review: true, react: false };
  // validated by Sumo at registration, BEFORE instantiation (static so doctor can read it)
  static config = z.object({
    repo:  z.string(),
    label: z.string().default('sumo:ready')
  });

  // ── the ONLY methods a developer implements: medium primitives ──
  // the base calls these; the developer never writes lifecycle logic.

  async *work() {                                   // ingress: yield RAW medium items
    for await (const issue of this.gh.issues({ label: this.config.label })) {
      yield {
        externalId: `${this.config.repo}#${issue.number}`,
        title: issue.title,
        body:  issue.body,
        kind:  issue.labels.includes('discussion') ? 'planning' : 'task',
        ext:   { number: issue.number, repo: this.config.repo }
      };
      // base turns each into a normalized `work` with bound methods + mirror + stable id
    }
  }

  async say(ref, text) {                            // post a message back to the item
    return this.gh.comment(ref.ext.number, text);
  }

  async mark(ref, who) {                            // claim state, behavior by argument:
    if (who === undefined) return this.gh.findMarker(ref.ext.number);   // read
    if (who === null) {                                                 // clear
      return this.gh.removeLabel(ref.ext.number, 'sumo:claimed');
    }
    await this.gh.addLabel(ref.ext.number, 'sumo:claimed');             // set (atomic ADD endpoint)
    return this.gh.comment(ref.ext.number, marker(who));
  }
}
```

```js
sumo.messenger(GitHubMessenger, { repo: 'acme/widgets' });   // flat registration, house-style
```

### The primitive set (what a developer overrides)

| Primitive | Required? | Purpose |
|---|---|---|
| `*work()` | required | async generator yielding raw medium items (ingress) |
| `say(ref, text)` | required | post a message back to the item's thread |
| `mark(ref, who)` | required if `can.claim` | claim state: `who===undefined` read · `who` set · `who===null` clear |
| `status(ref, s)` | optional | publish progress (defaults to `say` if absent) |
| `review(ref, r)` | optional | publish a review result (defaults to `say` if absent) |
| `react(ref, emoji)` | optional | only if `can.react` |

**Optional override points (for media that can do better):** an adapter whose medium has a *native
atomic claim* (e.g. a DB-backed messenger) may override `claim()` wholesale to skip the
read-after-write dance. The base provides the safe default; smarter media aren't forced into it.

### Naming rules applied (the surface developers type)

- A primitive is a domain noun or a single plain verb — never `verb+Noun+Qualifier`. (`mark`, not
  `setClaimMarker`/`readClaimMarker`/`clearClaimMarker`; `say`, not `postMessage`; `work`, not `pull`.)
- Behavior-by-argument over method-proliferation where it stays obvious (`mark(ref, who)`).
- The same concept uses the same word on author and consumer sides (`can` ↔ `work.can`).
- Inherited machinery nobody types may keep fuller names (`startHeartbeat`, `reclaimExpired`) —
  clarity over brevity for code developers don't write.

## Inherited machinery (written once in the base, never per-adapter)

The base class owns everything below. This is the abstraction the closure-bag lacked: the GitHub
author writes "how do I mark a label," not "what does claiming mean."

```js
// inside sumo/messenger base — inherited by every adapter
// returns the shared Result envelope (CONVENTIONS.md §3b): { ok:true, value } | { ok:false, reason, ... }
async claim(ref, agent) {
  const held = await this.mark(ref);                 // developer's read primitive
  if (held) return { ok: false, reason: 'held', heldBy: held };
  await this.mark(ref, agent);                       // developer's set primitive
  // VERIFIED: GitHub has no atomic CAS → read-after-write verify lives HERE, once.
  const after = await this.mark(ref);
  if (after !== agent) return { ok: false, reason: 'lost-race', heldBy: after };
  await this.mirror.set(ref, { agent, ttl: this.claimTtl });   // daemon-store mirror
  this.startHeartbeat(ref, agent);                             // TTL/heartbeat scheduling
  return { ok: true, value: { ref } };
}
```

> **Conventions conformance (CONVENTIONS.md §3b):** `claim` and other fallible primitives return the
> shared `Result` envelope (aligned #1). Unsupported optional primitives (`react`, `review` when
> `can` is false) return `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }` surfaced as a diagnostic
> (aligned #2) — never a silent no-op. `work` items share the normalized + `ext` + `dedupe` envelope
> with harness events (aligned #3) but remain a distinct payload type (divergent #2). Primitives
> throw only for programmer error; operational failures are `Result`s (aligned #4).

Inherited responsibilities: ingress loop driving `*work()` and normalizing each item into a `work`
object with bound methods; **claim semantics** (read-after-write verify, mirror, TTL, heartbeat,
reclaim-on-expiry); the **local daemon-store mirror** (so one machine's instances don't even race
each other before hitting the medium); **stable-id minting**; **event emission** onto the stream;
**redaction-on-egress** (never leak local secrets to a shared medium); **capability degradation**
(unsupported optional primitives → diagnostic, never silent no-op or fake success).

## Coordination is adapter-owned (no universal lock)

Claim state lives in each medium's native form; core never imposes a lock model:

| Contract | GitHub (first) | Slack | Jira | Email | MCP threads |
|---|---|---|---|---|---|
| ingress | labeled issues/PRs | channel msgs/mentions | JQL query | inbox by header/label | thread inbox |
| say/threads | issue/PR comments | channel threads | issue comments | reply chains (In-Reply-To) | thread messages |
| mark (claim) | label `sumo:claimed` + comment marker, read-after-write | reaction/emoji + threaded msg | transition "In Progress" + assignee | header `X-Sumo-Claim` | thread state field |
| heartbeat | timestamped comment edit | message edit/reaction | comment/worklog | follow-up email | heartbeat field |
| release | remove label / closing comment | reaction removal | transition "Done" | closing reply | release marker |
| review | PR review / check run | thread reply + reaction | comment + transition | reply | review message |

**Preventing duplicate claims across machines:** the medium's atomic-ish primitive is the source of
truth (GitHub: conditional add + read-after-write; Jira: transition guard; MCP: advisory lease); the
daemon-store mirror is a cache only. Claims carry TTL + heartbeat; expired claims are reclaimable.

## Consumer side (adapter-neutral; "github" never surfaces)

A workflow plugin consumes normalized `work` and never names the adapter. See
`03a-plugin-received-interfaces.md` for the full `work` shape. Bound methods: `work.reply`,
`work.claim`, `work.heartbeat`, `work.release`, `work.status`, `work.review`, `work.thread`,
`work.can.*`.

## Conformance

One parametrized suite (per `CONVENTIONS.md`) runs against every messenger adapter: it validates that
`*work()` items match the ingress schema, that declared `can` flags match exercised behavior, that
unsupported optionals degrade to diagnostics, and that the claim lifecycle (claim → heartbeat →
release, and reclaim-on-expiry) behaves identically regardless of medium. This is what proves the
same workflow plugin runs over GitHub, Slack, or Jira unchanged.

## Compatibility considerations

-   GitHub claim primitive details: label + comment-marker with read-after-write
  (recommended) vs native assignee vs GitHub's own mechanisms. No atomic CAS exists regardless.
-   Default claim TTL and heartbeat interval.
