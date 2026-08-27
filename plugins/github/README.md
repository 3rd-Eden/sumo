# `sumo/plugins/github` — the GitHub messenger

The first [`sumo/messenger`](../../packages/messenger/README.md) adapter: labeled GitHub issues become
normalized `work`; claims, comments, reviews, and proof-of-life flow back as issue labels + comments.
A workflow plugin consumes the `work` and does not need to know it came from GitHub.

The claim protocol uses authenticated HTML-comment markers with a last-active-claim-wins rule.

## Enable it

```yaml
# sumo.yml
use:
  - sumo/plugins/github
plugins:
  github:
    repo: owner/name          # required
    label: sumo:ready         # issues with this label are surfaced as work (default: sumo:ready)
    claimLabel: sumo:claimed  # applied while an issue is claimed (default: sumo:claimed)
    claimTtlMs: 300000        # claim TTL before it is reclaimable — 5m, from the reference implementation proofOfLife.timeout
    heartbeatMs: 60000        # liveness refresh interval — 1m, from the reference implementation watch.interval
    settleMs: 1000            # pause after posting a claim marker before the deciding re-read
    trust: write              # 'write' (default): honor markers only from authors with repo write
                              # access; 'all': trust every commenter (private/trusted repo only)
    # agent: my-instance-id   # optional claim identity (else a per-instance id is minted)
    # authors: [octocat, ci]  # optional explicit allowlist; overrides `trust`
```

The `label` / `claimLabel` must exist in the repo (the adapter creates `claimLabel` on first claim).

## Authentication — the `gh` CLI

The adapter shells out to the [`gh` CLI](https://cli.github.com); **it does no token handling of its
own** and inherits whatever `gh` is authenticated as. Authenticate once:

```sh
gh auth login          # or: export GH_TOKEN=…  /  GITHUB_TOKEN=…
gh auth status         # confirm
```

The account `gh` is logged in as needs read/write on `repo` (list issues, comment, edit labels, edit
comments). The same auth is what the conformance suite uses.

## How claiming works (GitHub has no atomic claim)

GitHub has **no atomic claim primitive** (verified): the add-label endpoint adds without
compare-and-set, and assignees do not reject duplicates. So claiming is **best-effort optimistic with
read-after-write**, never a lock:

1. **set** — add `claimLabel` + post a marker comment `<!-- sumo:claim agent="…" -->`.
2. **settle** — wait `settleMs` so GitHub's comment list converges.
3. **re-read** — fetch all comments (server order) and resolve the claimant: the **last** active claim
   marker since the last release wins (GitHub-leading, the reference implementation's `claimant`). If that is *you*, the
   claim stands; otherwise you lost the race and are told who holds it (`heldBy`).

A **heartbeat** edits the claim comment (bumping its server `updated_at`) rather than posting a new
one; a claim whose timestamp is older than `claimTtlMs` is **stale** and reclaimable. **Release**
removes `claimLabel` and posts `<!-- sumo:release agent="…" -->`.

> Ingress fetches **every** open issue via cursor-paginated GraphQL (`gh api graphql --paginate`, which
> is database-fresh and uncapped) and filters by label **client-side** — the `--label`/search path
> routes through GitHub's search index, which lags label changes by seconds, so a just-labeled issue
> would be missed.

### Trust model

Markers are HTML comments, which are **not** themselves an authentication boundary — anyone who can
comment on the issue can write the bytes `<!-- sumo:claim … -->`. Since these markers drive control
flow (who works, who stops, who's evicted), the adapter authenticates the comment **author**:

- **`trust: write` (default)** — a marker is honored only if its author has **write/maintain/admin
  permission on the repo** (resolved via the GitHub permission API, cached per author). GitHub's own
  access model is the boundary, so a random commenter cannot claim, release, or forge a liveness
  verdict. This is the recommended setting for shared/public repos.
- **`trust: all`** — honor every commenter (no permission lookups); only for a private, fully-trusted
  repo where comment access already implies authority.
- **`authors: [...]`** — an explicit login allowlist that overrides `trust`.

Write-permission gating stops outsiders, but a *compromised write-collaborator* could still post a
valid-looking marker, and it is not tamper-evident. **Cryptographically signed markers** (tracked in
the owning specification) are the future hardening for that higher tier; they are not built here.

## Proof-of-life (distributed coordination)

GitHub is a shared, cross-machine medium (`can.distributed: true`), so the messenger-layer
proof-of-life **send/receive** primitives are active: `requestProofOfLife` posts a `proof-of-life`
marker and emits `messenger.proof-of-life-request`; `publishLiveness` posts an `alive`/`release`
marker and emits `messenger.proof-of-life-response`. **Triggering it** (deciding a foreign claim needs
checking, running the health verdict, four-gate eviction) is the orchestrator's job and is not built
here.

## Tests

`conformance.test.mjs` runs **against real GitHub** using `SUMO_GITHUB_TEST_REPO` and a real daemon
database. It skips with a clear prerequisite when the variable, `gh` authentication, or repository
access is unavailable. Each live test creates a throwaway issue and closes it. Run:

```sh
SUMO_GITHUB_TEST_REPO=owner/repo node --test plugins/github/conformance.test.mjs
```
