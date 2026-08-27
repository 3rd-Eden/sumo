# 14 — Knowledge Base Plugin (first-party)

## What the Knowledge Base is

The KB is **the unified read/query/expose surface over everything Sumo knows** — not a parallel file
store. It follows Karpathy's three-layer pattern, mapped onto infrastructure we already have:

| Karpathy layer | Sumo realization |
|---|---|
| **Raw sources** (immutable, source of truth, read-never-written) | **The database** — every session, event, transcript, ingested agent plan, and **message**. Append-only (). |
| **The wiki** (LLM-owned, compiled, kept current) | **An OKF bundle** — markdown concepts with frontmatter provenance, `index.md` + `log.md`, cross-links as graph. Durable, portable, renders on GitHub. |
| **The schema** (conventions config) | **The KB plugin's rules** — concept `type`s, provenance tagging, curated-vs-raw, ingest/query/lint workflows. |

**It's both, layered — this is the key decision.** Knowledge lives **on disk as OKF** (portable,
agent-readable, git-diffable, survives Sumo) AND is **enhanced by the ecosystem** (our DB has the raw
substance, our daemon FTS + event correlation + session/plan/message relationships give discoverability
a flat OKF bundle can't have). OKF is the **output/interchange format**; the database is the
**substance**; the search index is a **rebuildable accelerator**.

## Three layers in detail

### 1. Raw layer = the database (immutable source of truth)
Everything Sumo ingests is already here (the whole point of the eventing discipline): sessions,
normalized events, transcript events, ingested plans (`agent-artifacts`), claims — **and messages**.
Per Karpathy, the raw layer is read but never rewritten; per  it's append-only with dedup on
identity. The KB never duplicates this into files — it *reads across* it.

**Messages as sources (your addition).** A message — a GitHub comment, a Slack thread, a human
instruction — is a unit of work and an ingestible source, exactly as Karpathy ingests articles. The
messenger layer's messages (`11`) flow into the raw layer as another source type, so "everything Sumo
knows" includes *conversational* work, not just code-execution. A KB concept may be compiled from a
message thread the same way as from a session transcript.

### 2. Wiki layer = the OKF bundle (compiled, durable, portable)
The KB compiles knowledge from the raw layer into **OKF concepts** — markdown + YAML frontmatter, one
concept per file, cross-linked. It is a **persistent, compounding artifact** (Karpathy): good query
answers and captured lessons are *filed back as new concepts*, not lost to chat history. Conventions:

- **Required `type`** (OKF). Sumo types: `lesson`, `decision`, `plan`, `session-summary`,
  `pattern`, `entity`, `overview`.
- **Sumo provenance rides as extra frontmatter keys** (OKF tolerates unknown keys — aligns with our
  `ext`-bag principle). Provenance is **source-links/spans/timestamps, NOT a confidence score**
  (practitioner-validated): `source`, `sessionId`, `messageRef`, `span`, `author` (human|agent),
  `supersedes`, `verifiedBy`.
- **`index.md`** — content catalog the agent reads first (Karpathy: sufficient at moderate scale,
  avoids embedding-RAG). **`log.md`** — append-only, greppable (`## [date] type | title`).
- **Cross-links are the graph.** (Future option, per the gist's pursultani thread: *typed* edges —
  `contradicts`/`supports`/`supersedes`. 1.0 uses plain links + a `supersedes` frontmatter key, since
  Sumo's engineering domain mostly treats contradiction as a defect to resolve, not content to keep.)

### 3. Discoverability layer = ecosystem enhancement (rebuildable)
Over the bundle, Sumo layers **daemon FTS (`minisearch`), event correlation, and session/plan/message
relationships**. Critical principle (vvvvvivekkk, validated): **the OKF bundle is durable truth; every
index is disposable and fully rebuildable from it + the DB.** So search is infrastructure, not memory.

## Built on the current plugin surface (the walk)

```js
export default function knowledge(sumo, options) {
  const kb = sumo.store('knowledge');   // curated namespace (provenance-tagged)

  // CAPTURE — observe the stream, compile concepts (filed back, Karpathy-style)
  sumo.on('review.posted', (e) => writeConcept(kb, conceptFrom(e)));
  sumo.on('message.received', (e) => maybeIngest(kb, e));   // messages as sources
  sumo.on('plan.ingested', (e) => writeConcept(kb, planConcept(e)));

  // SEARCH — one definition, surfaced on CLI + MCP (dynamic context for agents mid-session)
  sumo.command('kb-search', async ({ q, scope }, ctx) => {
    return scope === 'curated' ? kb.search(q) : sumo.search(q);   // curated vs raw (everything)
  });

  // DIAGNOSIS — read across all prior sessions, emit (surface, don't act)
  sumo.on('session.ended', async (e) => {
    const past = await sumo.search(similarTo(e));
    if (recurring(past)) await e.emit('kb.pattern-detected', { pattern, evidence: past });
  });

  // HANDOFF FEED — a skill a workflow/handoff plugin runs to pull relevant prior knowledge
  sumo.skill('kb-context', ({ sessionId }) => kb.search(contextFor(sessionId)));

  // EXPORT — render the OKF bundle to disk / a path (portable, GitHub-renderable)
  sumo.command('kb-export', ({ path }) => exportOKF(kb, path));
}
```

- **Capture** = `on` (observer, can't block) — compiles raw events/messages/plans into OKF concepts.
- **Search** = `command` (CLI + MCP) over the daemon index; `scope` picks curated vs raw.
- **Diagnosis** = `on('session.ended')` reading across history, **emits** a derived event (stays
  within §3c surface-don't-act — the orchestrator/plugin decides what to do).
- **Handoff feed** = `skill` (validates why `skill` was added) — a workflow runs `kb-context`.
- **Export** = `command` rendering the portable OKF bundle.

No primitive we don't have was needed.

## Curated vs. raw (the trust model)

Two tiers, both exposed, distinguished by `type` + provenance frontmatter:

- **Raw** = unfiltered DB fact (every session/event/message). Always queryable (`scope:'raw'`). No
  trust claim — it's just what happened.
- **Curated** = vetted insight (`lesson`/`decision`/`pattern`) with provenance. Trust rules
  (practitioner-validated): **provenance is source-traceable, not a confidence score**; **facts are
  superseded, not deleted** (`supersedes` frontmatter, old concept retained); **agent-authored
  concepts are gated** — written but excluded from curated search until corroborated (seen again, or
  confirmed by a human review). High-confidence corroboration auto-promotes; ambiguous flags for
  review. Optional Socratic gate (gist's Archimondstat): promote only what survives challenge.

## The autonomous-loop boundary (explicit, deliberate)

**1.0 scope = capture / search / diagnosis / handoff. NOT autonomous knowledge-gardening.** The
architecture makes crossing this *trivially easy* — `on('kb.pattern-detected')` → `sumo.run("update
the KB")` is three lines, and Karpathy's ingest→query→**lint** loop plus the reference implementation's shipped
knowledge-ratchet are the reference for the full version. That nearness is exactly why the boundary
must be **stated, not assumed**: 1.0 deliberately stops at capture/search/diagnosis/handoff; the
self-maintaining lint/promotion loop is a later, opt-in addition behind explicit configuration and
the gated-write rules above. This is a scope choice, not a capability gap.

## Three exposure faces

| Face | How | Use |
|---|---|---|
| **CLI** | `sumo kb-search`, `sumo kb-export` | humans query/export |
| **MCP** | `kb-search` as an MCP tool | **agents pull relevant context mid-session** — dynamic context to improve output (Karpathy's qmd-as-MCP pattern) |
| **OKF export** | `kb-export` → bundle on disk | portable, GitHub-renderable, interoperable with any OKF consumer |

## Acceptance tests

1. A `review.posted` event compiles an OKF-valid concept (`type` present) with source-traceable
   provenance, and updates `index.md` + appends to `log.md`.
2. `kb-search scope:curated` returns only vetted concepts; `scope:raw` returns across all DB facts.
3. An agent-authored concept without corroboration is excluded from curated results until a second
   source corroborates it.
4. A superseding fact adds a new concept with `supersedes:` and retains the old one (not deleted).
5. The OKF bundle is valid standalone on disk / renders on GitHub with no Sumo runtime.
6. The search index can be deleted and fully rebuilt from the bundle + DB (rebuildable-infra).
7. A message thread is ingestible as a source and compiles into a concept.
8. `kb-context` skill returns relevant prior knowledge for a handoff and is consumable by a second
   harness session.

## Compatibility considerations

-   Embeddings/semantic search: deferred for 1.0 (Karpathy + practitioners confirm
  `index.md` + lexical FTS is sufficient at moderate scale). Diagnosis ("find similar past sessions")
  is weaker without it — revisit if recall proves inadequate.
-   Typed relationship edges (`contradicts`/`supports`/`supersedes`) vs plain links +
  `supersedes` key. 1.0: plain links + `supersedes`. Typed edges if subjective-domain knowledge appears.
-   Where the OKF bundle lives by default (`~/.sumo/kb` vs per-project `.sumo/kb` vs a
  git repo the user designates).
