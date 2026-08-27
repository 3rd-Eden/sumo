/**
 * GitHub messenger adapter — `gh` CLI kind. The only medium-specific code: how to list labeled
 * issues (`*work`), post a comment (`say`), and coordinate a claim via a label + HTML-comment marker
 * (`mark`), plus the proof-of-life markers (`pulse`/`pulses`) and a heartbeat bump (`touch`). The
 * `sumo/messenger` base owns the claim lifecycle, mirror, events, redaction, and degradation.
 *
 * GitHub has **no atomic claim primitive** (VERIFIED, spec 11): the add-label endpoint adds without
 * compare-and-set and assignees do not reject duplicates. So claiming is best-effort optimistic — the
 * base posts a claim marker, settles, re-reads, and the medium's **last active claim wins**
 * (GitHub-leading, last active marker wins). Auth is the `gh` CLI (see README).
 *
 * @module sumo/plugins/github/github
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

import { Messenger, ok, fail } from 'sumo/messenger';
import { mark, has, parse } from './_marker.mjs';

const execFileAsync = promisify(execFile);

/** Repo identifier `owner/name`. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Open issues with their labels, cursor-paginated. Used with `gh api graphql --paginate`, which
 * follows `pageInfo.endCursor` to fetch EVERY open issue (no silent cap). GraphQL is database-fresh
 * (a just-labeled issue appears immediately, unlike the search-index-backed `--label` filter) and
 * `repository.issues` excludes pull requests, so no PR filtering is needed.
 */
const OPEN_ISSUES_QUERY = `
query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){
    issues(states:OPEN, first:100, after:$endCursor){
      nodes { number title body labels(first:100){ nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * The GitHub messenger config (validated at the plugin layer; also the adapter's introspection prop).
 * Durations follow the reference implementation: claim TTL = 5m, heartbeat = 1m.
 */
export const GitHubConfig = z.object({
  repo: z.string().regex(REPO_RE, 'repo must be "owner/name"'),
  label: z.string().default('sumo:ready'),
  claimLabel: z.string().default('sumo:claimed'),
  claimTtlMs: z.number().int().positive().default(300_000),
  heartbeatMs: z.number().int().positive().default(60_000),
  settleMs: z.number().int().nonnegative().default(1_000),
  // Who may drive claim/proof-of-life state via markers (HTML comments are not themselves an auth
  // boundary, so we gate on the comment AUTHOR):
  //   'write' (default) — only authors with write/maintain/admin permission on the repo (GitHub's own
  //                       access model is the boundary; a random commenter cannot claim/release/forge
  //                       liveness). One cached permission lookup per distinct author.
  //   'all'             — trust every commenter (zero extra calls; for a private, fully-trusted repo).
  trust: z.enum(['all', 'write']).default('write'),
  // Explicit login allowlist; when set it overrides `trust` (honor markers only from these logins).
  authors: z.array(z.string()).optional(),
  agent: z.string().optional()
});

/**
 * @typedef {z.infer<typeof GitHubConfig>} GitHubConfigShape
 * @typedef {Record<string, unknown> & { ext: { number: number, repo?: string } }} GitHubWorkRef
 * @typedef {{ id: number, body: string, login: string, created_at: string, updated_at: string }} GitHubComment
 * @typedef {{ agent: string, ts: number, stale?: boolean, ext?: { commentId?: number } }} GitHubClaimState
 */

/**
 * GitHubMessenger implementation.
 *
 * @access public
 * @class
 */
export class GitHubMessenger extends Messenger {
  id = 'github';

  // GitHub is a shared, cross-machine medium → proof-of-life plumbing is active (gated by the base).
  can = { reply: true, claim: true, status: true, review: true, react: false, distributed: true };

  config = GitHubConfig;

  /** @type {Set<string>} repos whose claim label we have confirmed exists this process. */
  #labelEnsured = new Set();

  /** @type {Map<string, boolean>} login → has-repo-write, cached per process (trust: 'write'). */
  #permCache = new Map();

  /**
   * The validated runtime config slice (`mctx.config`).
   *
   * @access public
   * @returns {GitHubConfigShape} Parsed GitHub plugin configuration.
   */
  get #cfg() {
    return /** @type {z.infer<typeof GitHubConfig>} */ (this.ctx.config);
  }

  // ── ingress ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Labeled open issues become work items. Every open issue is fetched via cursor-paginated GraphQL
   * (`gh api graphql --paginate` follows `endCursor` — no silent cap on large repos) and filtered by
   * label CLIENT-SIDE: the `--label`/search path lags label changes by seconds (VERIFIED — a
   * just-labeled issue is invisible to it), whereas GraphQL is database-fresh.
   *
   * @access public
   * @returns {AsyncGenerator<import('sumo/messenger').WorkSchema, void, unknown>} Open GitHub issues that match the configured work label.
   */
  async *work() {
    const { repo, label } = this.#cfg;
    const [owner, name] = repo.split('/');
    const out = await this.#gh([
      'api', 'graphql', '--paginate',
      '-f', `query=${OPEN_ISSUES_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '--jq', '.data.repository.issues.nodes[] | {number, title, body, labels: [.labels.nodes[].name]}'
    ]);
    // `--paginate` + a per-node `--jq` yields one JSON object per line, across all pages.
    /** @type {Array<{ number: number, title?: string, body?: string, labels?: string[] }>} */
    const issues = String(out).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const issue of issues) {
      const labels = issue.labels ?? [];
      if (!labels.includes(label)) continue;
      yield {
        externalId: `${repo}#${issue.number}`,
        title: issue.title,
        body: issue.body ?? '',
        kind: labels.includes('discussion') ? 'planning' : 'task',
        ext: {
          number: issue.number,
          repo
        }
      };
    }
  }

  // ── say / mark (the medium primitives the base drives) ──────────────────────────────────────────

  /**
   * Post a comment back to the issue. The body is already redacted by the caller (base `#reply` for
   *  user replies; `status`/`review` redact their free-text) — markers carry no secrets, so we do not
   *  re-redact here (that would mangle marker attributes like a token-shaped `agent`).
   *
   * @access public
   * @param {GitHubWorkRef} ref - GitHub issue work reference.
   * @param {string} text - Text used in the generated output.
   * @returns {Promise<import('sumo/error').Result>} Result of posting the comment.
   */
  async say(ref, text) {
    try {
      await this.#gh(['issue', 'comment', String(ref.ext.number), '--repo', this.#cfg.repo, '--body', text]);
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `github: comment failed — ${e?.message ?? e}`);
    }
  }

  /**
   * Claim state by argument: read (`undefined`) · set (`who`) · clear (`null`).
   *
   * @access public
   * @param {GitHubWorkRef} ref - GitHub issue work reference.
   * @param {string|null} [who] - Claimant to set, `null` to clear, or omitted to read.
   * @returns {Promise<GitHubClaimState|import('sumo/error').Result|undefined>} Claim state or write result.
   */
  async mark(ref, who) {
    const { repo } = this.#cfg;
    const n = ref.ext.number;
    if (who === undefined) return this.#readClaim(repo, n);
    if (who === null) return this.#clearClaim(repo, n);
    return this.#setClaim(repo, n, who);
  }

  /**
   * Walk all comments in server creation order (ascending `id`); the last claim marker not cleared by
   * a matching release/restart wins. A release clears only when its `agent` matches the current claim
   * (an agentless reset clears unconditionally), so one agent's release cannot wipe another's claim.
   *
   * @access public
   * @param {string} repo - Repository owner/name.
   * @param {number} n - N numeric value used by `readClaim`.
   * @returns {Promise<GitHubClaimState|undefined>} Last active claim marker state.
   */
  async #readClaim(repo, n) {
    const comments = (await this.#comments(repo, n)).sort((a, b) => Number(a.id) - Number(b.id));
    /** @type {GitHubClaimState|undefined} */
    let state;
    for (const c of comments) {
      if (!(await this.#trusted(c))) continue; // ignore markers from authors who may not drive claim state
      if (has(c.body, 'claim')) {
        const agent = parse(c.body, 'claim')?.agent;
        if (agent) {
          const parsed = Date.parse(c.updated_at || c.created_at);
          state = {
            agent,
            ts: Number.isFinite(parsed) ? parsed : Date.now(),
            ext: {
              commentId: c.id
            }
          };
        }
      } else if (has(c.body, 'release') || has(c.body, 'restart')) {
        const type = has(c.body, 'release') ? 'release' : 'restart';
        const ra = parse(c.body, type)?.agent;
        if (state && (!ra || ra === state.agent)) state = undefined;
      }
    }
    if (!state) return undefined;
    state.stale = Date.now() - state.ts > this.claimTtlMs;
    return state;
  }

  /**
   * Set: add the claim label + post a claim marker. (Marker is system text — not redacted.)
   *
   * @access public
   * @param {string} repo - Repository owner/name.
   * @param {number} n - N numeric value used by `setClaim`.
   * @param {string} who - Agent taking the claim.
   * @returns {Promise<import('sumo/error').Result>} Result of setting the claim marker.
   */
  async #setClaim(repo, n, who) {
    await this.#ensureClaimLabel(repo);
    await this.#gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', this.#cfg.claimLabel]);
    const body = `${mark('claim', { agent: who })}\nClaimed by \`${who}\`.`;
    await this.#gh(['issue', 'comment', String(n), '--repo', repo, '--body', body]);
    return ok();
  }

  /**
   * Clear: remove the claim label + post a release marker for the current claimant (the base only
   *  reaches here when the releasing agent IS the holder, so the recorded agent is correct).
   *
   * @access public
   * @param {string} repo - Repository owner/name.
   * @param {number} n - N numeric value used by `clearClaim`.
   * @returns {Promise<import('sumo/error').Result>} Result of clearing the claim marker.
   */
  async #clearClaim(repo, n) {
    const cur = await this.#readClaim(repo, n);
    const agent = cur?.agent ?? 'unknown';
    await this.#gh(['issue', 'edit', String(n), '--repo', repo, '--remove-label', this.#cfg.claimLabel]).catch(() => {});
    const body = `${mark('release', { agent })}\nReleased by \`${agent}\`.`;
    await this.#gh(['issue', 'comment', String(n), '--repo', repo, '--body', body]);
    return ok();
  }

  /**
   * Heartbeat: edit THIS agent's current claim comment so its server `updated_at` bumps (no new
   * comment). Resolves the comment id authoritatively from the medium each time — a cached id could
   * point at a loser's marker after a concurrent race. No-op if we are no longer the active claimant.
   *
   * @access public
   * @param {GitHubWorkRef} ref - GitHub issue work reference.
   * @param {string} agent - Agent whose active claim should be refreshed.
   * @returns {Promise<import('sumo/error').Result>} Result of refreshing or skipping the heartbeat.
   */
  async touch(ref, agent) {
    const { repo } = this.#cfg;
    const cur = await this.#readClaim(repo, ref.ext.number);
    if (!cur || cur.agent !== agent || !cur.ext?.commentId) return ok();
    const body = `${mark('claim', { agent })}\nClaimed by \`${agent}\` (heartbeat).`;
    await this.#gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${cur.ext.commentId}`, '-f', `body=${body}`]);
    return ok();
  }

  // ── status / review (markers are system text; only the free-text body is redacted) ──────────────

  /**
   * Post a status comment while keeping the machine marker separate from redacted free text.
   *
   * @access public
   * @param {Record<string, unknown>} ref - Work reference to inspect.
   * @param {object|string} status - Status supplied to `status`.
   * @returns {Promise<import('sumo/error').Result>} Promise that resolves with the shared Result returned by `status`.
   */
  async status(ref, status) {
    const data = status && typeof status === 'object' ? /** @type {Record<string, unknown>} */ (status) : {};
    const state = data.state ?? status;
    const text = data.text ?? `Status: ${state}`;
    return this.say(/** @type {GitHubWorkRef} */ (ref), `${mark('status', { state: String(state ?? '') })}\n${this.redact(String(text))}`);
  }

  /**
   * Post a review comment while preserving the verdict marker for later parsing.
   *
   * @access public
   * @param {Record<string, unknown>} ref - Work reference to inspect.
   * @param {Record<string, unknown>} review - Review supplied to `review`.
   * @returns {Promise<import('sumo/error').Result>} Promise that resolves with the shared Result returned by `review`.
   */
  async review(ref, review) {
    const text = review?.text ?? `Review: ${review?.verdict}`;
    return this.say(/** @type {GitHubWorkRef} */ (ref), `${mark('review', { verdict: String(review?.verdict ?? '') })}\n${this.redact(String(text))}`);
  }

  // ── proof-of-life medium primitives (the base gates on can.distributed) ─────────────────────────

  /**
   * Post a proof-of-life marker (`request`→`proof-of-life`; `alive`/`evict` verdicts).
   *
   * @access public
   * @param {GitHubWorkRef} ref - GitHub issue work reference.
   * @param {string} kind - Proof-of-life marker kind.
   * @param {Record<string, unknown>} data - Data supplied to `pulse`.
   * @returns {Promise<import('sumo/error').Result>} Result of posting the proof-of-life marker.
   */
  async pulse(ref, kind, data) {
    const type = kind === 'request' ? 'proof-of-life' : kind;
    /** @type {Record<string,string>} */
    const payload = {};
    for (const [k, v] of Object.entries(data ?? {})) if (v != null) payload[k] = String(v);
    await this.#gh(['issue', 'comment', String(ref.ext.number), '--repo', this.#cfg.repo, '--body', mark(type, payload)]);
    return ok();
  }

  /**
   * Read the proof-of-life markers on the issue (`proof-of-life` requests, `alive`/`evict` verdicts).
   *
   * @access public
   * @param {GitHubWorkRef} ref - GitHub issue work reference.
   * @returns {Promise<Array<Record<string, unknown>>>} Trusted proof-of-life markers on the issue.
   */
  async pulses(ref) {
    const comments = await this.#comments(this.#cfg.repo, ref.ext.number);
    /** @type {Array<Record<string, unknown>>} */
    const out = [];
    for (const c of comments) {
      if (!(await this.#trusted(c))) continue;
      for (const t of ['proof-of-life', 'alive', 'evict']) {
        if (has(c.body, t)) out.push({ kind: t, ...parse(c.body, t), ts: Date.parse(c.updated_at || c.created_at) });
      }
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether a comment's author may drive claim/proof-of-life state. An explicit `authors` allowlist
   * wins; otherwise `trust: 'all'` honors everyone and `trust: 'write'` (default) requires repo
   * write permission. Fails closed (untrusted) if a permission lookup errors.
   *
   * @access public
   * @param {GitHubComment} comment - GitHub issue comment carrying potential markers.
   * @returns {Promise<boolean>} Whether the comment author may drive coordination state.
   */
  async #trusted(comment) {
    const allow = this.#cfg.authors;
    if (allow && allow.length) return allow.includes(comment.login);
    if (this.#cfg.trust === 'all') return true;
    return this.#hasWrite(comment.login);
  }

  /**
   * True if `login` has write/maintain/admin permission on the repo. Cached per login per process.
   *
   * @access public
   * @param {string} login - GitHub login to check.
   * @returns {Promise<boolean>} Whether the login has write-level repository permission.
   */
  async #hasWrite(login) {
    if (!login) return false;
    if (this.#permCache.has(login)) return this.#permCache.get(login) ?? false;
    try {
      const out = await this.#gh(['api', `repos/${this.#cfg.repo}/collaborators/${login}/permission`, '--jq', '.permission']);
      const perm = String(out).trim();
      const trusted = perm === 'write' || perm === 'maintain' || perm === 'admin';
      this.#permCache.set(login, trusted); // cache only resolved answers
      return trusted;
    } catch {
      return false; // fail closed; do not cache, so a transient error is retried on the next read
    }
  }

  /**
   * Fetch all comments (paginated, server order) as `{ id, body, login, created_at, updated_at }`.
   *
   * @access public
   * @param {string} repo - Repository owner/name.
   * @param {number} n - N numeric value used by `comments`.
   * @returns {Promise<GitHubComment[]>} Issue comments in server order.
   */
  async #comments(repo, n) {
    const out = await this.#gh(['api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[] | {id, body, login: .user.login, created_at, updated_at}']);
    return String(out)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /**
   * Ensure the claim label exists in the repo (idempotent; cached only on success so a transient
   *  failure is retried rather than wrongly remembered as ensured).
   *
   * @access public
   * @param {string} repo - Repository owner/name.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #ensureClaimLabel(repo) {
    if (this.#labelEnsured.has(repo)) return;
    await this.#gh(['label', 'create', this.#cfg.claimLabel, '--repo', repo, '--color', 'ededed', '--force']);
    this.#labelEnsured.add(repo);
  }

  /**
   * Run a `gh` command, returning stdout. Throws on non-zero exit (the caller maps to a Result).
   *  Honors `ctx.signal` (runtime shutdown) and a timeout so an in-flight call cannot hang the loop.
   *
   * @access public
   * @param {string[]} args - Arguments passed to the `gh` executable.
   * @returns {Promise<string>} Standard output from the `gh` command.
   */
  async #gh(args) {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 16 * 1024 * 1024, timeout: 30_000, signal: this.ctx.signal
    });
    return stdout;
  }
}
