/**
 * `sumo/work` — first-party work-loop capabilities.
 *
 * This package is the small 1.0 workflow layer over the existing messenger/session/capability
 * contracts. It does not own GitHub polling or claim semantics; it reads messenger-produced
 * `work.*` events, reconstructs the recorded work reference, and drives the existing GitHub
 * messenger/session control surfaces.
 *
 * @module sumo/work
 */

import { z } from 'zod';
import { create } from 'sumo/capability';
import { open } from 'sumo/db';
import { GitHubMessenger, GitHubConfig } from 'sumo/plugins/github';

const EVT_PREFIX = 'evt:';
const DEFAULT_DETECT_TIMEOUT_MS = 250;
const DEFAULT_REVIEW_TIMEOUT_MS = 180_000;

/**
 * @typedef {Record<string, unknown> & {
 *   seq?: number,
 *   type?: string,
 *   adapter?: string,
 *   payload?: Record<string, unknown>
 * }} WorkEvent
 * @typedef {Record<string, unknown> & {
 *   id: string,
 *   externalId?: string,
 *   title?: string,
 *   body?: string,
 *   kind?: string,
 *   cwd?: string,
 *   ext?: Record<string, unknown>
 * }} WorkProjection
 * @typedef {{ config?: Record<string, unknown>, signal?: AbortSignal, db?: import('sumo/db').SumoDb }} WorkRegisterDeps
 * @typedef {{ ok: false, code: string, reason: string }} WorkFailure
 */

/**
 * Test whether a value is a non-array record.
 *
 * @access private
 * @param {unknown} value - Candidate value.
 * @returns {value is Record<string, unknown>} Whether the value is record-shaped.
 */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Test whether a value is an operational failure result.
 *
 * @access private
 * @param {unknown} value - Candidate value.
 * @returns {value is WorkFailure} Whether the value is a failed result.
 */
function failed(value) {
  return record(value) && value.ok === false && typeof value.code === 'string' && typeof value.reason === 'string';
}

/**
 * Return a successful messenger Result for work-factory placeholders.
 *
 * @access private
 * @returns {Promise<{ ok: true }>} Successful result.
 */
async function noopResult() {
  return { ok: true };
}

/**
 * Return a successful messenger claim Result for work-factory placeholders.
 *
 * @access private
 * @returns {Promise<{ ok: true, value: { ref: object } }>} Successful claim result.
 */
async function noopClaim() {
  return { ok: true, value: { ref: {} } };
}

/**
 * Read every event currently in the daemon log.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Sumo db client.
 * @returns {Promise<WorkEvent[]>} Events in sequence order.
 */
async function events(db) {
  /** @type {WorkEvent[]} */
  const rows = [];
  for await (const [, value] of db.scan(EVT_PREFIX)) rows.push(/** @type {WorkEvent} */ (value));
  rows.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  return rows;
}

/**
 * Build the latest work-state projection from messenger events.
 *
 * @access private
 * @param {WorkEvent[]} rows - Stored events.
 * @returns {{ work: Map<string, WorkProjection>, claimed: Set<string>, released: Set<string>, reviewed: Set<string>, runs: Map<string, string> }} Work-state index.
 */
function index(rows) {
  /** @type {Map<string, WorkProjection>} */
  const work = new Map();
  const claimed = new Set();
  const released = new Set();
  const reviewed = new Set();
  /** @type {Map<string, string>} */
  const runs = new Map();

  for (const event of rows) {
    const payload = record(event.payload) ? event.payload : {};
    const workRef = typeof payload.workRef === 'string' ? payload.workRef : undefined;
    if (event.type === 'work.appeared' && workRef) {
      const projected = record(payload.work) ? payload.work : payload;
      work.set(workRef, {
        id: workRef,
        ...(typeof projected.externalId === 'string' ? { externalId: projected.externalId } : {}),
        ...(typeof projected.title === 'string' ? { title: projected.title } : {}),
        ...(typeof projected.body === 'string' ? { body: projected.body } : {}),
        ...(typeof projected.kind === 'string' ? { kind: projected.kind } : {}),
        ...(typeof projected.cwd === 'string' ? { cwd: projected.cwd } : {}),
        ...(record(projected.ext) ? { ext: projected.ext } : {})
      });
    } else if (event.type === 'work.claimed' && workRef) {
      claimed.add(workRef);
    } else if (event.type === 'work.released' && workRef) {
      released.add(workRef);
    } else if (event.type === 'work.review-posted' && workRef) {
      reviewed.add(workRef);
    } else if (event.type === 'work.run-started' && workRef && typeof payload.sessionId === 'string') {
      runs.set(workRef, payload.sessionId);
    }
  }

  return { work, claimed, released, reviewed, runs };
}

/**
 * Find the first actionable work item, preferring explicitly requested ids.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Sumo db client.
 * @param {{ workRef?: string, timeoutMs?: number }} input - Detection request.
 * @returns {Promise<{ work?: WorkProjection, state: ReturnType<typeof index> }>} Detected work and state.
 */
async function findWork(db, input = {}) {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS);
  for (;;) {
    const state = index(await events(db));
    if (input.workRef) return { work: state.work.get(input.workRef), state };
    for (const [id, item] of state.work) {
      if (!state.claimed.has(id) && !state.released.has(id)) return { work: item, state };
    }
    if (Date.now() >= deadline) return { state };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Build a GitHub work ref from the persisted messenger projection.
 *
 * @access private
 * @param {WorkProjection} work - Work projection read from the event log.
 * @param {Record<string, unknown>} config - Validated GitHub config.
 * @returns {import('../../messenger/src/base/Messenger.mjs').WorkRef} Ref accepted by GitHubMessenger.
 */
function githubRef(work, config) {
  const repo = typeof work.ext?.repo === 'string' ? work.ext.repo : String(config.repo);
  const number = typeof work.ext?.number === 'number'
    ? work.ext.number
    : Number(String(work.externalId ?? '').split('#').at(-1));
  return {
    id: work.id,
    externalId: work.externalId,
    title: work.title,
    body: work.body,
    cwd: work.cwd,
    ext: {
      ...(work.ext ?? {}),
      repo,
      number
    }
  };
}

/**
 * Create a GitHub messenger bound to the current runtime config.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Sumo db client.
 * @param {WorkRegisterDeps} deps - Runtime dependencies.
 * @returns {GitHubMessenger | WorkFailure} Messenger or operational failure.
 */
function github(db, deps) {
  const config = deps.config ?? {};
  const pluginConfig = record(config.plugins) && record(config.plugins.github) ? config.plugins.github : undefined;
  const parsed = GitHubConfig.safeParse(pluginConfig ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: 'SUMO_CAP_UNSUPPORTED',
      reason: `github work loop requires plugins.github config: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    };
  }
  return new GitHubMessenger({
    config: parsed.data,
    signal: deps.signal,
    db,
    /**
     * Build a messenger work object for GitHub operations.
     *
     * @access private
     * @param {Record<string, unknown>} spec - Work fields supplied by the adapter.
     * @returns {import('../../messenger/src/base/Messenger.mjs').BoundWork} Work object with required defaults.
     */
    work: (spec) => ({
      ext: {},
      can: {},
      ...spec,
      reply: noopResult,
      claim: noopClaim,
      heartbeat: noopResult,
      release: noopResult,
      status: noopResult,
      review: noopResult,
      react: noopResult
    })
  });
}

/**
 * Append a workflow event that is not emitted by the messenger layer itself.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Sumo db client.
 * @param {string} type - Event type.
 * @param {string} workRef - Work id.
 * @param {Record<string, unknown>} payload - Event payload.
 * @returns {Promise<number>} Event seq.
 */
function emit(db, type, workRef, payload = {}) {
  return db.append({
    dedupe: `work:${type}:${workRef}:${payload.sessionId ?? Date.now()}`,
    type,
    source: 'plugin',
    payload: { workRef, ...payload }
  });
}

/**
 * Register work-loop capabilities.
 *
 * @access public
 * @param {{ command: (capability: import('sumo/capability').CapabilityDef) => void }} sumo - Sumo facade.
 * @param {WorkRegisterDeps} deps - Runtime dependencies.
 * @returns {void} Completes without producing a value.
 */
export function register(sumo, deps = {}) {
  sumo.command(create({
    name: 'work.detect',
    title: 'Detect Work',
    description: 'Scorer: passes when a messenger-produced work item is available and not released.',
    inputSchema: z.object({
      workRef: z.string().optional(),
      timeoutMs: z.number().int().nonnegative().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Detect the next actionable work item.
     *
     * @access private
     * @param {{ workRef?: string, timeoutMs?: number }} input - Detection input.
     * @returns {Promise<Record<string, unknown>>} Scorer result.
     */
    async exec(input) {
      const db = deps.db ?? await open({});
      try {
        const { work } = await findWork(db, input);
        return {
          pass: !!work,
          ...(work ? { workRef: work.id, work } : {}),
          message: work ? `work available: ${work.title ?? work.id}` : 'no actionable work available'
        };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'work.claim',
    title: 'Claim Work',
    description: 'Claim the selected work item through its messenger medium.',
    inputSchema: z.object({
      workRef: z.string().optional(),
      agent: z.string().optional(),
      timeoutMs: z.number().int().nonnegative().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Claim an actionable work item.
     *
     * @access private
     * @param {{ workRef?: string, agent?: string, timeoutMs?: number }} input - Claim input.
     * @returns {Promise<Record<string, unknown>>} Claim result.
     */
    async exec(input) {
      const db = deps.db ?? await open({});
      try {
        const { work } = await findWork(db, input);
        if (!work) return { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'no actionable work available to claim' };
        const adapter = github(db, deps);
        if (failed(adapter)) return adapter;
        const result = await adapter.claim(githubRef(/** @type {WorkProjection} */ (work), adapter.ctx.config), input.agent);
        if (!result.ok) return result;
        return { workRef: work.id, work, agent: input.agent ?? adapter.ctx.config.agent ?? 'agent' };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'work.run',
    title: 'Run Work',
    description: 'Spawn a worker session for a claimed work item.',
    inputSchema: z.object({
      workRef: z.string().optional(),
      prompt: z.string().optional(),
      cwd: z.string().optional(),
      harness: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
      timeoutMs: z.number().int().nonnegative().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Spawn a worker session for a work item.
     *
     * @access private
     * @param {{ workRef?: string, prompt?: string, cwd?: string, harness?: string, agent?: string, model?: string, reasoningEffort?: string, timeoutMs?: number }} input - Run input.
     * @param {{ cwd?: string }} ctx - Invocation context.
     * @returns {Promise<Record<string, unknown>>} Worker spawn result.
     */
    async exec(input, ctx) {
      const db = deps.db ?? await open({});
      try {
        const { work, state } = await findWork(db, input);
        if (!work) return { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'no work item available to run' };
        if (!state.claimed.has(work.id) || state.released.has(work.id)) {
          return { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'work must be claimed before it can run' };
        }
        const cwd = input.cwd ?? work.cwd ?? (typeof ctx.cwd === 'string' ? ctx.cwd : undefined) ?? process.cwd();
        const prompt = input.prompt ?? [
          `Work item: ${work.title ?? work.id}`,
          work.body ? `\n${work.body}` : '',
          '\nImplement the requested work, run focused verification, and summarize the result.'
        ].join('');
        const result = await db.session({
          sessionId: '',
          action: 'spawn',
          cwd,
          payload: {
            prompt,
            cwd,
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
          }
        });
        if (!result.ok) return result;
        const session = record(result.value) ? result.value : {};
        const sessionId = typeof session.id === 'string' ? session.id : typeof session.sessionId === 'string' ? session.sessionId : undefined;
        if (sessionId) await emit(db, 'work.run-started', work.id, { sessionId });
        return { workRef: work.id, work, sessionId };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'work.review',
    title: 'Review Work',
    description: 'Scorer: wait for a worker session to finish, then post a minimum review verdict.',
    inputSchema: z.object({
      workRef: z.string().optional(),
      sessionId: z.string().optional(),
      verdict: z.enum(['pass', 'request-changes']).default('pass'),
      text: z.string().optional(),
      timeoutMs: z.number().int().positive().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Review a completed worker session.
     *
     * @access private
     * @param {{ workRef?: string, sessionId?: string, verdict: 'pass'|'request-changes', text?: string, timeoutMs?: number }} input - Review input.
     * @returns {Promise<Record<string, unknown>>} Scorer result.
     */
    async exec(input) {
      const db = deps.db ?? await open({});
      try {
        const { work, state } = await findWork(db, input);
        if (!work) return { pass: false, message: 'no work item available to review' };
        const sessionId = input.sessionId ?? state.runs.get(work.id);
        if (sessionId) {
          const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS);
          for (;;) {
            const doc = await db.get(`ses:${sessionId}`);
            if (record(doc) && (doc.state === 'ended' || doc.state === 'dead')) break;
            if (Date.now() >= deadline) return { pass: false, message: `session ${sessionId} did not finish before review timeout` };
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        const adapter = github(db, deps);
        if (failed(adapter)) return { pass: false, workRef: work.id, message: adapter.reason };
        const posted = await adapter.review(githubRef(/** @type {WorkProjection} */ (work), adapter.ctx.config), {
          verdict: input.verdict === 'pass' ? 'pass' : 'request-changes',
          text: input.text ?? (input.verdict === 'pass' ? '1.0 review passed.' : 'Changes requested.')
        });
        if (!posted.ok) return { pass: false, message: posted.reason };
        return {
          pass: input.verdict === 'pass',
          workRef: work.id,
          message: `review verdict=${input.verdict}`
        };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'work.release',
    title: 'Release Work',
    description: 'Release a claimed work item through its messenger medium.',
    inputSchema: z.object({
      workRef: z.string().optional(),
      agent: z.string().optional(),
      outcome: z.record(z.string(), z.unknown()).optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Release a claimed work item.
     *
     * @access private
     * @param {{ workRef?: string, agent?: string, outcome?: Record<string, unknown> }} input - Release input.
     * @returns {Promise<Record<string, unknown>>} Release result.
     */
    async exec(input) {
      const db = deps.db ?? await open({});
      try {
        const { work } = await findWork(db, input);
        if (!work) return { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'no work item available to release' };
        const adapter = github(db, deps);
        if (failed(adapter)) return adapter;
        const result = await adapter.release(githubRef(/** @type {WorkProjection} */ (work), adapter.ctx.config), input.outcome ?? {}, input.agent);
        if (!result.ok) return result;
        return { workRef: work.id, released: true };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'work.released',
    title: 'Work Released',
    description: 'Scorer: passes when a work item is released, or when no work item was available.',
    inputSchema: z.object({
      workRef: z.string().optional()
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Score whether a work item has been released.
     *
     * @access private
     * @param {{ workRef?: string }} input - Release scorer input.
     * @returns {Promise<Record<string, unknown>>} Scorer result.
     */
    async exec(input) {
      const db = deps.db ?? await open({});
      try {
        const state = index(await events(db));
        if (!input.workRef && state.work.size === 0) return { pass: true, message: 'no work was available' };
        const workRef = input.workRef ?? [...state.work.keys()].at(-1);
        const pass = !!workRef && state.released.has(workRef);
        return { pass, workRef, message: pass ? `released ${workRef}` : `not released ${workRef ?? '(none)'}` };
      } finally {
        if (!deps.db) await db.close();
      }
    }
  }));
}
