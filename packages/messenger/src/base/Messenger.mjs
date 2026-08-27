/**
 * `sumo/messenger` base class — the lifted abstraction (the unified adapter idiom, CONVENTIONS
 * §3a/§4; ). It is the one place `extends` appears in a messenger author's world: an adapter
 * declares its `id`/`can`/`config` instance props and implements a small set of short medium
 * primitives (`*work()`, `say`, `mark`, optional `status`/`review`/`react`, and — for a distributed
 * medium — `touch`/`pulse`/`pulses`). The base owns everything genuinely shared:
 *
 *  - the ingress loop driving `*work()` and normalizing each raw item into the consumer `work` object
 *    (via `mctx.work`) with bound `reply`/`claim`/`heartbeat`/`release`/`status`/`review` methods;
 *  - the **claim lifecycle** — GitHub has no atomic CAS (VERIFIED, spec 11), so a claim is best-effort
 *    optimistic: post the claim marker → settle → re-read → the medium's **last active claim wins**
 *    (GitHub-leading). The base treats the adapter's `mark()` read as an opaque `ClaimState`; claim
 *    history/expiry are the adapter's (medium-specific);
 *  - the local **claims mirror** (a CACHE in `mctx.store`; the medium is the source of truth);
 *  - **stable-id minting** + **idempotent re-ingest** (a seen-set so re-polling does not re-fire);
 *  - **event emission** onto the one log via the injected daemon client (`mctx.db.append`);
 *  - **redaction-on-egress** (never leak a local secret into a posted message);
 *  - **capability degradation** (an optional primitive whose `can` is false →
 *    `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }`, never silent/fake);
 *  - **proof-of-life plumbing** (the SEND/RECEIVE medium primitives + `messenger.*` events), gated by
 *    `can.distributed`. The orchestrator decides WHEN to ask and supplies the health verdict (,
 *    deferred); the messenger owns the medium and the event plumbing so an orchestrator can drive it.
 *
 * @module sumo/messenger/base/Messenger
 */

import { createHash, randomUUID } from 'node:crypto';

import { ok, fail, isResult, CAP_UNSUPPORTED, WorkSchema } from '../schema.mjs';
import { SumoError } from 'sumo/error';
import { sleep, withDefined } from 'sumo/util';
import { logError } from 'sumo/log';

/** Default claim TTL + heartbeat (ms), from coordination defaults (`proofOfLife.timeout`, `watch.interval`). */
const DEFAULTS = { claimTtlMs: 300_000, heartbeatMs: 60_000, settleMs: 1_000 };
const NEVER_ABORT = new AbortController().signal;

/**
 * @typedef {Record<string, unknown> & {
 *   id: string,
 *   externalId?: string,
 *   title?: string,
 *   body?: string,
 *   cwd?: string,
 *   ext?: Record<string, unknown>
 * }} WorkRef
 */

/**
 * @typedef {Record<string, unknown> & {
 *   reply: (text: string) => Promise<import('../schema.mjs').Result>,
 *   claim: () => Promise<import('../schema.mjs').ClaimResult>,
 *   heartbeat: () => Promise<import('../schema.mjs').Result>,
 *   release: (outcome?: Record<string, unknown>) => Promise<import('../schema.mjs').Result>,
 *   status: (s: Record<string, unknown>) => Promise<import('../schema.mjs').Result>,
 *   review: (r: Record<string, unknown>) => Promise<import('../schema.mjs').Result>,
 *   react: (emoji: string) => Promise<import('../schema.mjs').Result>
 * }} BoundWork
 */

/**
 * @typedef {object} MessengerStore
 * @property {(key: string) => Promise<unknown|undefined>} get - Read a scoped value.
 * @property {(key: string, value: unknown, opts?: { ttlMs?: number }) => Promise<void>} set - Write a scoped value.
 * @property {(key: string) => Promise<void>} del - Delete a scoped value.
 */

/**
 * @typedef {object} MessengerContext
 * @property {Record<string, unknown>} config - Adapter config slice.
 * @property {AbortSignal} signal - Runtime shutdown signal.
 * @property {(spec: Record<string, unknown>) => BoundWork} work - Runtime work-object builder.
 * @property {MessengerStore} [store] - Scoped plugin store for seen and claim mirrors.
 * @property {import('sumo/db').SumoDb} [db] - Daemon client used for event emission.
 */

/**
 * @typedef {object} OptionalPrimitives
 * @property {(ref: WorkRef, agent: string) => Promise<import('../schema.mjs').Result|void>} [touch] - Refresh a medium-native claim.
 * @property {(ref: WorkRef, kind: string, data: Record<string, unknown>) => Promise<import('../schema.mjs').Result|void>} [pulse] - Post a proof-of-life marker.
 * @property {(ref: WorkRef) => Promise<unknown>} [pulses] - Read proof-of-life markers.
 * @property {(ref: WorkRef, status: Record<string, unknown>) => Promise<import('../schema.mjs').Result|void>} [status] - Post a status update.
 * @property {(ref: WorkRef, review: Record<string, unknown>) => Promise<import('../schema.mjs').Result|void>} [review] - Post a review.
 * @property {(ref: WorkRef, emoji: string) => Promise<import('../schema.mjs').Result|void>} [react] - Post a reaction.
 */

/** Token-shaped secrets scrubbed from user-supplied text posted to a shared medium (redaction-on-
 *  egress). Applied to free text only — never to system-generated markers (whose `agent`/`state`
 *  attributes are not secrets and must not be mangled). */
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / user-to-server / server-to-server / refresh
  /github_pat_[A-Za-z0-9_]{20,}/g, // fine-grained PAT
  /\bsk-(?:ant-)?[A-Za-z0-9-]{20,}/g, // OpenAI / Anthropic API keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:xox[baprs]-[A-Za-z0-9-]{10,})\b/g // Slack tokens
];

/**
 * Messenger implementation.
 *
 * @access public
 * @class
 */
export class Messenger {
  /** @type {string} the messenger id (e.g. 'github'); matches the registration name. */
  id = '';

  /** @type {import('../schema.mjs').MessengerCan} declared capabilities (authoring-time). */
  can = {};

  /** @type {import('zod').ZodTypeAny|undefined} per-messenger config contract (introspection). */
  config = undefined;

  /** @type {number} claim time-to-live before it is reclaimable (ms). */
  claimTtlMs = DEFAULTS.claimTtlMs;

  /** @type {number} heartbeat interval refreshing a held claim (ms). */
  heartbeatMs = DEFAULTS.heartbeatMs;

  /** @type {number} pause after posting a claim marker, letting the medium converge before re-read (ms). */
  settleMs = DEFAULTS.settleMs;

  /** @type {MessengerContext} runtime context injected by the plugin provider. */
  ctx;

  /**
   * Create an instance.
   *
   * @access public
   * @param {Partial<MessengerContext>} ctx - Runtime context supplied by the plugin provider.
   */
  constructor(ctx = {}) {
    this.ctx = {
      ...ctx,
      config: ctx.config ?? {},
      signal: ctx.signal ?? NEVER_ABORT,
      work: ctx.work ?? ((spec) => /** @type {BoundWork} */ (spec))
    };
    // Per-instance agent identity: configured (so two claimers can be distinct) else minted.
    const config = this.ctx.config ?? {};
    this.#agentId = typeof config.agent === 'string' ? config.agent : `agent_${randomUUID()}`;
    if (typeof config.claimTtlMs === 'number') this.claimTtlMs = config.claimTtlMs;
    if (typeof config.heartbeatMs === 'number') this.heartbeatMs = config.heartbeatMs;
    if (typeof config.settleMs === 'number') this.settleMs = config.settleMs;
  }

  /** @type {string} */ #agentId = '';
  /** @type {Map<string, ReturnType<typeof setInterval>>} */ #heartbeats = new Map();
  /** @type {Map<string, () => void>} abort listeners per claim, so they can be removed on stop. */ #abortListeners = new Map();
  /** Per-instance nonce so recurring-event dedupe keys never collide across process restarts. */ #nonce = randomUUID();
  #evtSeq = 0;

  // ── Author hooks (the adapter implements these) ──────────────────────────────────────────────────

  /**
   * INGRESS (`read`): an async generator yielding RAW medium items (`WorkSchema`s). Abstract.
   * @returns {AsyncGenerator<import('../schema.mjs').WorkSchema>} Raw work items read from the medium.
   */
  // eslint-disable-next-line require-yield
  /**
   * Base implementation for `work`.
   *
   * @access public
   * @returns {AsyncGenerator<unknown, void, unknown>} Generated normalized records.
   */
  async *work() {
    throw new SumoError({ name: 'messenger', method: 'work', code: 'SUMO_NOT_IMPLEMENTED', message: `messenger '${this.id}' does not implement *work()` });
  }

  // eslint-disable-next-line class-methods-use-this
  /**
   * Post a message in reply to a work reference.
   *
   * @access public
   * @param {Record<string, unknown>} _ref - Work reference to reply to.
   * @param {string} _text - Message body to post.
   * @returns {Promise<import('../schema.mjs').Result|void>} Promise that resolves after the reply is posted.
   */
  async say(_ref, _text) {
    throw new SumoError({ name: 'messenger', method: 'say', code: 'SUMO_NOT_IMPLEMENTED', message: `messenger '${this.id}' does not implement say(ref, text)` });
  }

  // eslint-disable-next-line class-methods-use-this
  /**
   * Base implementation for `mark`.
   *
   * @access public
   * @param {Record<string, unknown>} _ref - Work reference whose claim marker is read or changed.
   * @param {string|null} [_who] - Claimant to set, `null` to clear, or omitted to read.
   * @returns {Promise<import('../schema.mjs').ClaimState|import('../schema.mjs').Result|undefined>} Claim state, operational Result, or no active claim.
   */
  async mark(_ref, _who) {
    throw new SumoError({ name: 'messenger', method: 'mark', code: 'SUMO_NOT_IMPLEMENTED', message: `messenger '${this.id}' does not implement mark(ref, who)` });
  }

  // Optional adapter hooks (presence-probed): status(ref,s), review(ref,r), react(ref,emoji),
  // touch(ref,agent) [bump claim liveness on the medium], pulse(ref,kind,data) [post a proof-of-life
  // marker], pulses(ref) [read proof-of-life markers]. The base never assumes them — it gates on `can`
  // and `typeof`.

  // ── Lifecycle: ingress ───────────────────────────────────────────────────────────────────────────

  /**
   * Drive the adapter's `*work()`: validate each raw item, mint a stable id, dedupe (idempotent
   * re-ingest), build the bound consumer `work` object, emit `work.appeared`, and yield it. The plugin
   * runtime fans each yielded work onto the `on('work', …)` channel. Honors `ctx.signal`.
   *
   * @access public
   * @returns {AsyncGenerator<BoundWork>} Bound work objects delivered to plugin handlers.
   */
  async *ingress() {
    for await (const raw of this.work()) {
      if (this.ctx.signal.aborted) break;
      const item = WorkSchema.parse(raw);
      const id = this.#workId(item.externalId);
      if (await this.#seen(id)) continue; // re-polling the same item does not re-fire (idempotent)
      /** @type {WorkRef} */
      const ref = {
        id, externalId: item.externalId, title: item.title, body: item.body, cwd: item.cwd,
        // ext preserves adapter fields + the normalized kind/externalId so the work is reconstructable.
        ext: Object.assign({}, item.ext, { kind: item.kind, externalId: item.externalId })
      };
      const work = this.#buildWork(ref);
      // Mark seen only AFTER the durable append succeeds — a swallowed append must not strand the item
      // (seen-but-never-logged). On append failure we still deliver live but leave it unseen to re-fire.
      const seq = await this.#emit('work.appeared', {
        workRef: id,
        kind: item.kind,
        externalId: item.externalId,
        work: {
          id,
          externalId: item.externalId,
          title: item.title,
          body: item.body,
          kind: item.kind,
          cwd: item.cwd,
          ext: ref.ext
        }
      }, ref, 'once');
      if (seq != null) await this.#markSeen(id);
      yield work;
    }
  }

  /**
   * Build the consumer `work` object (via `mctx.work`) with capability-gated, redacted, bound methods.
   *
   * @access public
   * @param {WorkRef} ref - Normalized work reference.
   * @returns {BoundWork} Work object with medium effectors bound to this messenger.
   */
  #buildWork(ref) {
    const messenger = this;
    const can = {
      reply: !!this.can.reply, claim: !!this.can.claim, status: !!this.can.status, review: !!this.can.review, react: !!this.can.react
    };
    const build = this.ctx.work;
    return build(withDefined({
      id: ref.id, title: ref.title, body: ref.body, ext: ref.ext, can, /**
       * Reply through the adapter after capability gating and redaction.
       *
       * @access public
       * @param {string} text - Text used in the generated output.
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `reply`.
       */
      reply(/** @type {string} */ text) { return messenger.#reply(ref, text); }, /**
       * Execute `claim`.
       *
       * @access public
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `claim`.
       */
      claim() { return messenger.claim(ref, messenger.#agentId); }, /**
       * Execute `heartbeat`.
       *
       * @access public
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `heartbeat`.
       */
      heartbeat() { return messenger.heartbeat(ref, messenger.#agentId); }, /**
       * Release this work item with an optional outcome payload.
       *
       * @access public
       * @param {Record<string, unknown>} outcome - Outcome supplied to `release`.
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `release`.
       */
      release(/** @type {Record<string, unknown>} */ outcome) { return messenger.release(ref, outcome ?? {}); }, /**
       * Post a medium-native status update when the adapter supports it.
       *
       * @access public
       * @param {Record<string, unknown>} s - S supplied to `status`.
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `status`.
       */
      status(/** @type {Record<string, unknown>} */ s) { return messenger.#status(ref, s); }, /**
       * Post a medium-native review when the adapter supports it.
       *
       * @access public
       * @param {Record<string, unknown>} r - R supplied to `review`.
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `review`.
       */
      review(/** @type {Record<string, unknown>} */ r) { return messenger.#review(ref, r); }, /**
       * React to the work item when the adapter supports reactions.
       *
       * @access public
       * @param {string} emoji - Emoji supplied to `react`.
       * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `react`.
       */
      react(/** @type {string} */ emoji) { return messenger.#react(ref, emoji); }
    }, { cwd: ref.cwd }));
  }

  // ── Lifecycle: claim (read-after-write, last-claim-wins; the medium is the source of truth) ──────

  /**
   * Claim `ref` for `agent`. Best-effort optimistic (GitHub has no atomic CAS): pre-check the current
   * claim, post a claim marker, settle, re-read — if the medium's last active claim is `agent`, the
   * claim stands; else it was lost. The local mirror is only a cache and never authorizes a claim the
   * medium did not.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {string} agent - Agent identifier.
   * @returns {Promise<import('../schema.mjs').ClaimResult>} Promise that resolves with the shared Result returned by `claim`.
   */
  async claim(ref, agent = this.#agentId) {
    if (!this.can.claim) return fail(CAP_UNSUPPORTED, `${this.id}: claim unsupported`);
    try {
      // Fast negative pre-check against the local mirror: a sibling instance on this machine shares the
      // daemon store, so a fresh mirror entry for another agent means we needn't hit the medium just to
      // lose (spec 11 "so one machine's instances don't even race each other"). The mirror can only DENY
      // here, never GRANT — a miss/stale entry falls through to the authoritative medium read below.
      const cached = await this.#mirrorGet(ref.id);
      if (cached && cached.agent !== agent && !this.#expired(cached)) {
        return { ok: false, code: 'SUMO_CLAIM_HELD', reason: `held by ${cached.agent}`, heldBy: cached.agent };
      }

      const held = await this.mark(ref);
      const heldResult = isResult(held) ? /** @type {import('../schema.mjs').Result} */ (held) : null;
      if (heldResult?.ok === false) return heldResult; // adapter surfaced a medium failure on read
      const heldClaim = heldResult ? undefined : /** @type {import('../schema.mjs').ClaimState|undefined} */ (held);
      if (heldClaim && !heldClaim.stale && heldClaim.agent !== agent) {
        return { ok: false, code: 'SUMO_CLAIM_HELD', reason: `held by ${heldClaim.agent}`, heldBy: heldClaim.agent };
      }

      const set = await this.mark(ref, agent); // post the claim marker (set)
      const setResult = isResult(set) ? /** @type {import('../schema.mjs').Result} */ (set) : null;
      if (setResult?.ok === false) return setResult;
      await sleep(this.settleMs); // let the medium converge before the deciding read
      let after = await this.mark(ref); // re-read: adapter returns the LAST active claim (GitHub-leading)
      let afterResult = isResult(after) ? /** @type {import('../schema.mjs').Result} */ (after) : null;
      if (afterResult?.ok === false) return afterResult;
      let afterClaim = afterResult ? undefined : /** @type {import('../schema.mjs').ClaimState|undefined} */ (after);
      if (!afterClaim && this.settleMs > 0) {
        await sleep(this.settleMs);
        after = await this.mark(ref);
        afterResult = isResult(after) ? /** @type {import('../schema.mjs').Result} */ (after) : null;
        if (afterResult?.ok === false) return afterResult;
        afterClaim = afterResult ? undefined : /** @type {import('../schema.mjs').ClaimState|undefined} */ (after);
      }
      if (!afterClaim || afterClaim.agent !== agent) {
        return { ok: false, code: 'SUMO_CLAIM_LOST', reason: `lost to ${afterClaim?.agent ?? 'release'}`, heldBy: afterClaim?.agent };
      }

      const ts = Number.isFinite(afterClaim.ts) ? afterClaim.ts : Date.now();
      await this.#mirrorSet(ref.id, { agent, ts });
      this.startHeartbeat(ref, agent);
      await this.#emit('work.claimed', { workRef: ref.id, agent }, ref, agent); // dedupe per agent → reclaims are distinct
      return /** @type {import('../schema.mjs').ClaimResult} */ (ok({ ref }));
    } catch (e) {
      // A medium primitive failed (e.g. the `gh` CLI). Operational failure → Result, not a throw (§3b).
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: claim failed — ${e?.message ?? e}`);
    }
  }

  /**
   * One heartbeat: bump the medium's claim liveness (if the adapter supports it) + refresh the mirror.
   *
   * @access public
   * @param {WorkRef} ref - Work reference whose claim is refreshed.
   * @param {string} agent - Agent whose claim should be refreshed.
   * @returns {Promise<import('../schema.mjs').Result>} Result for the heartbeat update.
   */
  async heartbeat(ref, agent = this.#agentId) {
    if (!this.can.claim) return fail(CAP_UNSUPPORTED, `${this.id}: claim unsupported`);
    try {
      const adapter = /** @type {OptionalPrimitives} */ (this);
      if (typeof adapter.touch === 'function') {
        const touched = await adapter.touch(ref, agent);
        const touchedResult = isResult(touched) ? /** @type {import('../schema.mjs').Result} */ (touched) : null;
        if (touchedResult?.ok === false) return touchedResult;
      }
      await this.#mirrorSet(ref.id, { agent, ts: Date.now() });
      await this.#emit('work.heartbeat', { workRef: ref.id }, ref, this.#tick());
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: heartbeat failed — ${e?.message ?? e}`);
    }
  }

  /**
   * Schedule periodic heartbeats for a held claim. Unref'd; stops on release or `ctx.signal` abort.
   *
   * @access public
   * @param {WorkRef} ref - Work reference whose claim should be refreshed periodically.
   * @param {string} agent - Agent whose claim should be refreshed.
   * @returns {void} Completes without producing a value.
   */
  startHeartbeat(ref, agent = this.#agentId) {
    this.stopHeartbeat(ref.id);
    const timer = setInterval(() => {
      this.heartbeat(ref, agent).catch(() => {}); // best-effort; a failed beat never crashes the loop
    }, this.heartbeatMs);
    timer.unref();
    this.#heartbeats.set(ref.id, timer);
    // Stop on shutdown; track the listener so stopHeartbeat can remove it (no per-cycle leak).
    const messenger = this;
    /**
     * Stop the heartbeat for this work item when the messenger runtime aborts.
     *
     * @access public
     * @returns {void} Completes without producing a value.
     */
    function onAbort() {
      messenger.stopHeartbeat(ref.id);
    }
    this.#abortListeners.set(ref.id, onAbort);
    this.ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  /**
   * Stop heartbeats for a claim (by work id) and remove its abort listener.
   *
   * @access public
   * @param {string} id - Identifier used by `stopHeartbeat`.
   * @returns {void} Completes without producing a value.
   */
  stopHeartbeat(id) {
    const t = this.#heartbeats.get(id);
    if (t) {
      clearInterval(t);
      this.#heartbeats.delete(id);
    }
    const onAbort = this.#abortListeners.get(id);
    if (onAbort) {
      this.ctx.signal.removeEventListener('abort', onAbort);
      this.#abortListeners.delete(id);
    }
  }

  /**
   * Release `ref`: stop heartbeats, clear the medium marker + label, drop the mirror, emit. Agent-aware
   * — only the current holder clears, so a stale agent cannot wipe a newer agent's claim. The bound
   * `work.release()` uses this instance's agent; the explicit form lets the orchestrator release a
   * specific agent's claim.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to release.
   * @param {Record<string, unknown>} outcome - Outcome supplied to `release`.
   * @param {string} agent - Agent identifier.
   * @returns {Promise<import('../schema.mjs').Result>} Result for the release operation.
   */
  async release(ref, outcome = {}, agent = this.#agentId) {
    if (!this.can.claim) return fail(CAP_UNSUPPORTED, `${this.id}: claim unsupported`);
    this.stopHeartbeat(ref.id);
    try {
      const cur = await this.mark(ref);
      const curResult = isResult(cur) ? /** @type {import('../schema.mjs').Result} */ (cur) : null;
      if (curResult?.ok === false) return curResult;
      const curClaim = curResult ? undefined : /** @type {import('../schema.mjs').ClaimState|undefined} */ (cur);
      if (curClaim && curClaim.agent !== agent) {
        // We are not the holder — releasing would clobber another agent's claim. No-op (not an error);
        // leave their mirror entry untouched.
        return ok();
      }
      const cleared = await this.mark(ref, null); // clear: the adapter records the (matching) claimant in the release marker
      const clearedResult = isResult(cleared) ? /** @type {import('../schema.mjs').Result} */ (cleared) : null;
      if (clearedResult?.ok === false) return clearedResult;
      await this.#mirrorDel(ref.id);
      await this.#emit('work.released', { workRef: ref.id, outcome }, ref, this.#tick());
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: release failed — ${e?.message ?? e}`);
    }
  }

  // ── Consumer-facing wrappers (capability-gate + redact + emit) ──────────────────────────────────

  /**
   * Reply through the adapter's medium primitive after redaction.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {string} text - Text used in the generated output.
   * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `reply`.
   */
  async #reply(ref, text) {
    if (!this.can.reply) return fail(CAP_UNSUPPORTED, `${this.id}: reply unsupported`);
    return this.#asResult(this.say(ref, this.redact(String(text ?? ''))));
  }

  /**
   * Post status only when the adapter declares and implements status support.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {Record<string, unknown>} s - S supplied to `status`.
   * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `status`.
   */
  async #status(ref, s) {
    if (!this.can.status) {
      return fail(CAP_UNSUPPORTED, `${this.id}: status unsupported`);
    }
    const adapter = /** @type {OptionalPrimitives} */ (this);
    const r = await this.#asResult(adapter.status?.(ref, s));
    if (r.ok) await this.#emit('work.status', { workRef: ref.id, status: s }, ref, this.#tick()); // only record what actually posted
    return r;
  }

  /**
   * Post a review and emit the event only after the medium confirms success.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {Record<string, unknown>} review - Review supplied to `review`.
   * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `review`.
   */
  async #review(ref, review) {
    if (!this.can.review) {
      return fail(CAP_UNSUPPORTED, `${this.id}: review unsupported`);
    }
    const adapter = /** @type {OptionalPrimitives} */ (this);
    const r = await this.#asResult(adapter.review?.(ref, review));
    if (r.ok) await this.#emit('work.review-posted', { workRef: ref.id, verdict: review?.verdict }, ref, this.#tick());
    return r;
  }

  /**
   * React through the adapter's optional medium primitive.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {string} emoji - Emoji supplied to `react`.
   * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `react`.
   */
  async #react(ref, emoji) {
    if (!this.can.react) {
      return fail(CAP_UNSUPPORTED, `${this.id}: reactions unsupported`);
    }
    const adapter = /** @type {OptionalPrimitives} */ (this);
    return this.#asResult(adapter.react?.(ref, emoji));
  }

  // ── Proof-of-life plumbing (SEND/RECEIVE medium primitives + events; gated `can.distributed`) ────

  /**
   * Surface a foreign-claim liveness QUESTION on the medium and emit `messenger.proof-of-life-request`.
   * The orchestrator decides when to call this and supplies the health answer (); the messenger
   * owns the medium + event. No-op-degraded when the medium is not distributed.
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @param {string} agent - Agent identifier.
   * @returns {Promise<import('../schema.mjs').Result>} Result for publishing the liveness request.
   */
  async requestProofOfLife(ref, agent) {
    if (!this.can.distributed) return fail(CAP_UNSUPPORTED, `${this.id}: proof-of-life unsupported (not a distributed medium)`);
    try {
      const adapter = /** @type {OptionalPrimitives} */ (this);
      const pulsed = await adapter.pulse?.(ref, 'request', { agent });
      const pulsedResult = isResult(pulsed) ? /** @type {import('../schema.mjs').Result} */ (pulsed) : null;
      if (pulsedResult?.ok === false) return pulsedResult;
      await this.#emit('messenger.proof-of-life-request', { agent, requestRef: ref.id }, ref, this.#tick());
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: proof-of-life request failed — ${e?.message ?? e}`);
    }
  }

  /**
   * Publish a liveness VERDICT (from the orchestrator) on the medium + emit
   * `messenger.proof-of-life-response`. An unhealthy verdict posts a release marker.
   *
   * @access public
   * @param {WorkRef} ref - Work reference whose medium thread receives the verdict.
   * @param {string} agent - Agent whose liveness is being reported.
   * @param {Record<string, unknown>} verdict - Claim verdict to record.
   * @returns {Promise<import('../schema.mjs').Result>} Result for publishing the liveness verdict.
   */
  async publishLiveness(ref, agent, verdict) {
    if (!this.can.distributed) return fail(CAP_UNSUPPORTED, `${this.id}: proof-of-life unsupported (not a distributed medium)`);
    const alive = !!verdict?.alive;
    try {
      const adapter = /** @type {OptionalPrimitives} */ (this);
      const pulsed = await adapter.pulse?.(ref, alive ? 'alive' : 'evict', { agent, status: verdict?.status });
      const pulsedResult = isResult(pulsed) ? /** @type {import('../schema.mjs').Result} */ (pulsed) : null;
      if (pulsedResult?.ok === false) return pulsedResult;
      await this.#emit('messenger.proof-of-life-response', { agent, alive }, ref, this.#tick());
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: liveness publish failed — ${e?.message ?? e}`);
    }
  }

  /**
   * Read the proof-of-life markers currently on `ref`'s medium thread (for a responder/orchestrator).
   *
   * @access public
   * @param {WorkRef} ref - Work reference to inspect.
   * @returns {Promise<import('../schema.mjs').Result>} Promise that resolves with the shared Result returned by `readProofOfLife`.
   */
  async readProofOfLife(ref) {
    if (!this.can.distributed) return fail(CAP_UNSUPPORTED, `${this.id}: proof-of-life unsupported (not a distributed medium)`);
    try {
      const adapter = /** @type {OptionalPrimitives} */ (this);
      const items = await adapter.pulses?.(ref);
      return ok(items);
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `${this.id}: proof-of-life read failed — ${e?.message ?? e}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Mint a deterministic Sumo work id from the adapter id + the medium's external id (idempotent).
   *
   * @access public
   * @param {string} externalId - Identifier used by `workId`.
   * @returns {string} Deterministic Sumo work id for the external id.
   */
  #workId(externalId) {
    return `work_${createHash('sha256').update(`${this.id}:${externalId}`).digest('hex').slice(0, 32)}`;
  }

  /**
   * Check the durable seen marker so repeated ingress does not duplicate work items.
   *
   * @access public
   * @param {string} id - Identifier used by `seen`.
   * @returns {Promise<boolean>} Promise that resolves with whether `seen` succeeded.
   */
  async #seen(id) {
    const store = this.ctx.store;
    if (!store || typeof store.get !== 'function') return false;
    return (await store.get(`seen:${id}`)) === true;
  }

  /**
   * Persist a durable seen marker for an ingested work item.
   *
   * @access public
   * @param {string} id - Identifier used by `markSeen`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #markSeen(id) {
    const store = this.ctx.store;
    if (store && typeof store.set === 'function') await store.set(`seen:${id}`, true);
  }

  /**
   * Read mirrored claim state from the plugin store.
   *
   * @access public
   * @param {string} id - Identifier used by `mirrorGet`.
   * @returns {Promise<{ agent?: string, ts?: number }|undefined>} Mirrored claim state, if present.
   */
  async #mirrorGet(id) {
    const store = this.ctx.store;
    if (!store || typeof store.get !== 'function') return undefined;
    return /** @type {Promise<{ agent?: string, ts?: number }|undefined>} */ (store.get(`claim:${id}`));
  }

  /**
   * Mirror claim state with a TTL so stale distributed claims expire.
   *
   * @access public
   * @param {string} id - Identifier used by `mirrorSet`.
   * @param {{ agent?: string, ts?: number }} value - Claim state to mirror locally.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #mirrorSet(id, value) {
    const store = this.ctx.store;
    if (store && typeof store.set === 'function') await store.set(`claim:${id}`, value, { ttlMs: this.claimTtlMs });
  }

  /**
   * Remove mirrored claim state after release.
   *
   * @access public
   * @param {string} id - Identifier used by `mirrorDel`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #mirrorDel(id) {
    const store = this.ctx.store;
    if (store && typeof store.del === 'function') await store.del(`claim:${id}`);
  }

  /**
   * A mirror entry is stale (reclaimable) once its recorded timestamp is older than the claim TTL.
   *  A missing/non-finite timestamp is treated as stale (fail-open to the authoritative medium read).
   *
   * @access public
   * @param {{ ts?: number }|undefined|null} entry - Mirrored claim state to inspect.
   * @returns {boolean} Whether the mirror entry is stale.
   */
  #expired(entry) {
    return !entry || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts) || Date.now() - entry.ts > this.claimTtlMs;
  }

  /**
   * Normalize an adapter primitive's return (`Result | void | Promise`) into a `Result`.
   *
   * @access public
   * @param {unknown} ret - Adapter primitive return value or promise.
   * @returns {Promise<import('../schema.mjs').Result>} Shared Result for the primitive outcome.
   */
  async #asResult(ret) {
    const v = await ret;
    return isResult(v) ? /** @type {import('../schema.mjs').Result} */ (v) : ok();
  }

  /**
   * Scrub token-shaped secrets before any egress to a shared medium (CONVENTIONS §5, one policy). The
   * base applies it on the consumer `reply` path; an adapter MUST also apply it at each of its own post
   * sites (messages, status/review bodies, markers) — this is the single shared redactor they call.
   * @param {string} textText used in the generated output.
   */
  // eslint-disable-next-line class-methods-use-this
  /**
   * Base implementation for `redact`.
   *
   * @access public
   * @param {string} text - Text used in the generated output.
   * @returns {string} Text with token-shaped secrets replaced.
   */
  redact(text) {
    let out = String(text ?? '');
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
    return out;
  }

  /**
   * Append a `work.*`/`messenger.*` event to the one log via the daemon client. Returns the assigned
   * seq on success, or `null` on a (swallowed) append failure so the caller can decide — e.g. ingress
   * leaves the item unseen to re-fire rather than stranding it (no silent loss). The `discriminator`
   * forms the dedupe key's tail: a stable value (e.g. `'once'`, the agent) collapses idempotently; a
   * `#tick()` value makes each occurrence distinct (and survives restarts via the per-instance nonce).
   *
   * @access public
   * @param {string} type - Event name or type handled by `emit`.
   * @param {Record<string, unknown>} payload - Payload consumed by `emit`.
   * @param {Record<string, unknown>} ref - Ref supplied to `emit`.
   * @param {unknown} discriminator - Discriminator supplied to `emit`.
   * @returns {Promise<number|null>} Promise resolving to the `emit` result.
   */
  async #emit(type, payload, ref, discriminator = this.#tick()) {
    const db = this.ctx.db;
    if (!db || typeof db.append !== 'function') return null; // robustness fallback; the runtime injects db
    try {
      return await db.append({
        dedupe: `messenger:${this.id}:${type}:${ref.id}:${discriminator}`, type, source: 'messenger', adapter: this.id, payload, ext: {}
      });
    } catch (error) {
      logError(error, { source: 'sumo/messenger', messenger: this.id, type, workRef: ref.id });
      return null; // the daemon surfaces append failures; never crash the ingress/claim path
    }
  }

  /**
   * A unique per-occurrence dedupe token for recurring events: the per-instance nonce (fresh each
   *  process, so no cross-restart collision) + a monotonic counter (disambiguates same-instant emits).
   *
   * @access public
   * @returns {string} Unique per-occurrence dedupe discriminator.
   */
  #tick() {
    return `${this.#nonce}:${this.#evtSeq++}`;
  }
}
