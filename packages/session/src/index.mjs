/**
 * `sumo/session` — the session handle contract and first-party control capabilities.
 *
 * Pure mechanism: no business logic or actor policy lives here. This package owns:
 *  - `CapabilitiesSchema` — the per-session frozen capability descriptor (spec 04 §"install-and-verify");
 *    the authoritative runtime contract for what a live session handle can do.
 *  - `Session` — the typed JSDoc contract for the session handle returned by `sumo.run(...)`.
 *  - `register` — first-party session control capabilities (spec 16, ).
 *
 * @module sumo/session
 */

import fs from 'node:fs';

import { z } from 'zod';
import { create } from 'sumo/capability';
import { open, key } from 'sumo/db';
import { adapters } from 'sumo/agent-artifacts';
import { sleep } from 'sumo/util';

const LIVE_UNAVAILABLE = new Set([
  'SUMO_RATE_LIMITED',
  'SUMO_AUTH_REQUIRED',
  'SUMO_BUDGET_EXHAUSTED',
  'SUMO_BACKEND_UNAVAILABLE',
  'SUMO_OVERLOADED'
]);

/**
 * Test whether a value is a non-array object.
 *
 * @access private
 * @param {unknown} value - Candidate value.
 * @returns {value is Record<string, unknown>} Whether value is record-shaped.
 */
function record(value) {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Session document fields this package reads from the daemon registry.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   harness?: string,
 *   harnessSessionId?: string,
 *   cwd?: string,
 *   model?: string,
 *   state?: string,
 *   createdAt?: number,
 *   transcriptPath?: string,
 *   ext?: Record<string, unknown>
 * }} SessionDoc
 */

/**
 * Stored event fields read by session-control waiters.
 * @typedef {Record<string, unknown> & {
 * type?: string,
 * sessionId?: string,
 * rawRef?: string,
 * payload?: Record<string, unknown>,
 * ext?: {
 * nativeSessionId?: string,
 * classification?: { code?: string },
 * native?: { params?: { turn?: { id?: string, status?: string } } }
 * }
 * }} SessionEventRecord
 */

/**
 * The per-session capability descriptor, computed at spawn by install-and-verify and then frozen
 * (spec 04 §"install-and-verify"). It is the concrete form of "declare, don't fake" (): every flag
 * states what THIS session actually supports, verified rather than assumed.
 *
 * `observationSource` and `canSendKey`/`canCapture` are INDEPENDENT axes (the tmux-pane decision, 04):
 * a default stdio session is `event-stream` + no key/capture; a tmux-pane interactive session is
 * `transcript-file` (live events come from the on-disk transcript via agent-artifacts/09, not the
 * pane scrape) + key/capture. One does not imply the other.
 *
 * @typedef {object} CapabilitiesSchema
 * @property {boolean} [canDeny]
 * @property {boolean} [canModifyInput]
 * @property {boolean} [canInjectContext]
 * @property {boolean} [canAsk]
 * @property {boolean} [canDefer]
 * @property {boolean} [canApprove]      - server-initiated approvals (respondApproval) available
 * @property {boolean} [canCancel]       - session.cancel() is available (interrupt active work)
 * @property {boolean} [canSendKey]      - interactive key injection (tmux pane) available
 * @property {boolean} [canCapture]      - raw screen snapshot (tmux capture-pane) available
 * @property {'transcript-file'|'event-stream'} [observationSource] - where live events are read from
 * @property {boolean} [transcriptComplete] - false when the harness may omit records (e.g. Cursor tool output)
 * @property {boolean} [steeringVerified]    - the install-and-verify self-test passed
 */
export const CapabilitiesSchema = z
  .object({
    canDeny: z.boolean().optional(),
    canModifyInput: z.boolean().optional(),
    canInjectContext: z.boolean().optional(),
    canAsk: z.boolean().optional(),
    canDefer: z.boolean().optional(),
    canApprove: z.boolean().optional(),
    canCancel: z.boolean().optional(),
    canSendKey: z.boolean().optional(),
    canCapture: z.boolean().optional(),
    observationSource: z.enum(['transcript-file', 'event-stream']).optional(),
    transcriptComplete: z.boolean().optional(),
    steeringVerified: z.boolean().optional()
  })
  .passthrough();

/**
 * The session handle returned by `sumo.run(...)` (03a §2). Built by the harness layer (`hctx.session`);
 * here it is the typed contract returned by the session-control boundary.
 * @typedef {object} Session
 * @property {string} id
 * @property {string} state
 * @property {CapabilitiesSchema} capabilities
 * @property {(text: string) => Promise<void>} send
 * @property {(key: string) => Promise<void>} key
 * @property {(line: string) => Promise<void>} command
 * @property {() => Promise<string>} capture
 * @property {() => AsyncIterable<SessionEventRecord>} join
 * @property {() => Promise<void>} done
 * @property {(opts?: { force?: boolean }) => Promise<void>} end
 * @property {(decision: object) => Promise<void>} [respondApproval]
 */

/**
 * Drain a scan prefix into an array of values.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `scanValues` to read or write Sumo state.
 * @param {string} prefix - Registry key prefix to scan.
 * @returns {Promise<SessionDoc[]>} Session documents stored below the prefix.
 */
async function scanValues(db, prefix) {
  /** @type {SessionDoc[]} */
  const out = [];
  for await (const [, value] of db.scan(prefix)) out.push(/** @type {SessionDoc} */ (value));
  return out;
}

/**
 * Default no-op resolver placeholder for async waiters before the real resolver is assigned.
 *
 * @access private
 * @returns {void} Completes without producing a value.
 */
function noop() {}

/**
 * Return a live-prerequisite failure code surfaced on a session event, if one is present.
 *
 * @access private
 * @param {SessionEventRecord} event - Session event that may carry a live-prerequisite failure code.
 * @returns {string} String returned by `liveUnavailableCode`.
 */
function liveUnavailableCode(event) {
  const code = event?.ext?.classification?.code ?? event?.payload?.sumoCode;
  return typeof code === 'string' && LIVE_UNAVAILABLE.has(code) ? code : '';
}

/**
 * Return whether a session doc matches expected model metadata.
 *
 * @access private
 * @param {SessionDoc} doc - Session document read from the daemon registry.
 * @param {{ expectModel?: string, expectTier?: string }} input - Expected model metadata.
 * @returns {boolean} Whether the model expectations are satisfied.
 */
function modelMatches(doc, input) {
  if (input.expectModel && doc.model !== input.expectModel) return false;
  if (input.expectTier && doc.ext?.tier !== input.expectTier) return false;
  return true;
}

/**
 * Read one `ses:<id>` document (opens + closes its own daemon connection).
 *
 * @access private
 * @param {string} sessionId - Identifier used by `readSesDoc`.
 * @returns {Promise<SessionDoc|undefined>} Stored session document, when present.
 */
async function readSesDoc(sessionId) {
  const db = await open({});
  try {
    return /** @type {SessionDoc|undefined} */ (await db.get(key(sessionId)));
  } finally {
    await db.close();
  }
}

/**
 * Parse a JSONL transcript file into decoded records.
 *
 * @access private
 * @param {string} file - Path read or written by `readJsonl`.
 * @returns {Array<Record<string, unknown>>} Parsed transcript records.
 */
function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Count assistant `session.message` events stored for a session (the shared-uuid dedupe witness).
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `countAssistantMessages` to read or write Sumo state.
 * @param {string} sessionId - Identifier used by `countAssistantMessages`.
 * @returns {Promise<number>} Number of assistant message events for the session.
 */
async function countAssistantMessages(db, sessionId) {
  let n = 0;
  for await (const [, raw] of db.scan('evt:')) {
    const v = /** @type {SessionEventRecord} */ (raw);
    if (v && v.sessionId === sessionId && v.type === 'session.message' && v.payload?.role === 'assistant') n++;
  }
  return n;
}

/**
 * Wait for assistant turns through the event subscription path instead of rescanning the whole log.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `waitForAssistantMessages` to read or write Sumo state.
 * @param {string} sessionId - Identifier used by `waitForAssistantMessages`.
 * @param {number} want - Assistant message count to wait for.
 * @param {number} timeoutMs - Timeout ms numeric value used by `waitForAssistantMessages`.
 * @returns {Promise<{ timeout: boolean, count: number }>} Wait result with final assistant count.
 */
async function waitForAssistantMessages(db, sessionId, want, timeoutMs) {
  let n = 0;
  let finish = /** @type {(value: { timeout: boolean, count: number }) => void} */ (noop);
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      timeout: true,
      count: n
    }), timeoutMs);
    /**
     * Resolve the assistant-message wait and clear its timeout.
     *
     * @access private
     * @param {{ timeout: boolean, count: number }} value - Assistant-message wait result.
     * @returns {void} Completes without producing a value.
     */
    finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  const unsubscribe = await db.subscribe({
    since: 0,
    filter: {
      type: ['session.message'],
      sessionId
    }
  }, (event) => {
    const current = /** @type {SessionEventRecord} */ (event);
    if (current.payload?.role === 'assistant') n++;
    if (n >= want) {
      finish({
        timeout: false,
        count: n
      });
    }
  });
  try {
    return await done;
  } finally {
    unsubscribe();
  }
}

/**
 * Wait for a native turn-started event from a running session.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Database client used by the operation.
 * @param {string} sessionId - Identifier used by `waitForActiveTurn`.
 * @param {number} timeoutMs - Timeout ms numeric value used by `waitForActiveTurn`.
 * @returns {Promise<{ timeout: boolean, count: number, turnId?: string }>} Promise resolving to the `waitForActiveTurn` result.
 */
async function waitForActiveTurn(db, sessionId, timeoutMs) {
  let count = 0;
  let turnId;
  let finish = /** @type {(value: { timeout: boolean, count: number, turnId?: string }) => void} */ (noop);
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      timeout: true,
      count
    }), timeoutMs);
    /**
     * Resolve the turn-start wait and clear its timeout.
     *
     * @access private
     * @param {{ timeout: boolean, count: number, turnId?: string }} value - Turn-start wait result.
     * @returns {void} Completes without producing a value.
     */
    finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  const unsubscribe = await db.subscribe({
    since: 0,
    filter: {
      sessionId
    }
  }, (event) => {
    const current = /** @type {SessionEventRecord} */ (event);
    if (current.type !== 'session.turn-started') return;
    count++;
    turnId = typeof current.payload?.turnId === 'string' ? current.payload.turnId : undefined;
    finish({
      timeout: false,
      count,
      ...(turnId ? {
        turnId
      } : {})
    });
  });
  try {
    return await done;
  } finally {
    unsubscribe();
  }
}

/**
 * Wait for a native turn-completed event from a running session.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Database client used by the operation.
 * @param {string} sessionId - Identifier used by `waitForTurnCompleted`.
 * @param {string | undefined} wantTurnId - Want turn id supplied to `waitForTurnCompleted`.
 * @param {number} timeoutMs - Timeout ms numeric value used by `waitForTurnCompleted`.
 * @returns {Promise<{ timeout: boolean, count: number, turnId?: string, status?: string, unavailableCode?: string }>} Promise resolving to the `waitForTurnCompleted` result.
 */
async function waitForTurnCompleted(db, sessionId, wantTurnId, timeoutMs) {
 let count = 0;
 let turnId;
 let status;
 let finish = /** @type {(value: { timeout: boolean, count: number, turnId?: string, status?: string, unavailableCode?: string }) => void} */ (noop);
 const done = new Promise((resolve) => {
 const timer = setTimeout(() => resolve({
 timeout: true,
 count
 }), timeoutMs);
 /**
 * Resolve the turn-completed wait and clear its timeout.
 *
 * @access private
 * @param {{ timeout: boolean, count: number, turnId?: string, status?: string, unavailableCode?: string }} value - Turn-completed wait result.
 * @returns {void} Completes without producing a value.
 */
 finish = (value) => {
 clearTimeout(timer);
 resolve(value);
 };
 });
 const unsubscribe = await db.subscribe({
 since: 0,
 filter: {
 sessionId
 }
 }, (event) => { void inspect(/** @type {SessionEventRecord} */ (event)); });

 /**
 * Inspect one event and, for native turn frames, load its redacted raw evidence through rawRef.
 *
 * @access private
 * @param {SessionEventRecord} current - Event supplied by the subscription.
 * @returns {Promise<void>} Resolves after the event has been classified.
 */
 async function inspect(current) {
 const unavailableCode = liveUnavailableCode(current);
 if (unavailableCode) {
 finish({
 timeout: false,
 count,
 unavailableCode
 });
 return;
 }
 if (current.type !== 'session.raw:turn.completed') return;
 const raw = current.rawRef ? await db.get(current.rawRef): current.ext?.native;
 const native = Array.isArray(raw) ? raw.at(-1): raw;
 const turn = record(native) && record(native.params) && record(native.params.turn) ? native.params.turn: {};
 const completedTurnId = typeof turn.id === 'string' ? turn.id: undefined;
 if (wantTurnId && completedTurnId !== wantTurnId) return;
 count++;
 turnId = completedTurnId;
 status = typeof turn.status === 'string' ? turn.status: undefined;
 finish({
 timeout: false,
 count,
 ...(turnId ? {
 turnId
 }: {}),
 ...(status ? {
 status
 }: {})
 });
 }
 try {
 return await done;
 } finally {
 unsubscribe();
 }
}

/**
 * Wait for a Sumo-keyed event carrying the harness-native id through the event subscription path.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `waitForCorrelatedEvents` to read or write Sumo state.
 * @param {string} sessionId - Identifier used by `waitForCorrelatedEvents`.
 * @param {number} timeoutMs - Timeout ms numeric value used by `waitForCorrelatedEvents`.
 * @returns {Promise<{ pass: boolean, keyed: number, withNative: number }>} Correlation counts observed before timeout.
 */
async function waitForCorrelatedEvents(db, sessionId, timeoutMs) {
  let keyed = 0;
  let withNative = 0;
  let finish = /** @type {(value: { pass: boolean, keyed: number, withNative: number }) => void} */ (noop);
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      pass: false,
      keyed,
      withNative
    }), timeoutMs);
    /**
     * Resolve the correlation wait and clear its timeout.
     *
     * @access private
     * @param {{ pass: boolean, keyed: number, withNative: number }} value - Correlation wait result.
     * @returns {void} Completes without producing a value.
     */
    finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  const unsubscribe = await db.subscribe({
    since: 0,
    filter: {
      sessionId
    }
  }, (event) => {
    const current = /** @type {SessionEventRecord} */ (event);
    keyed++;
    if (typeof current.ext?.nativeSessionId === 'string' && current.ext.nativeSessionId.length > 0) withNative++;
    if (keyed > 0 && withNative > 0) {
      finish({
        pass: true,
        keyed,
        withNative
      });
    }
  });
  try {
    return await done;
  } finally {
    unsubscribe();
  }
}

/**
 * Register all first-party session control capabilities on the given `sumo` facade.
 * Must be called BEFORE `runtime.start()`.
 *
 * @access public
 * @param {{ command: (cap: import('sumo/capability').CapabilityDef) => void }} sumo - Sumo supplied to `register`.
 * @returns {void} Completes without producing a value.
 */
export function register(sumo) {
 if (registeredFacades.has(sumo)) return;
 registeredFacades.add(sumo);
 sumo.command(create({
 name: 'sessions',
 title: 'List Sessions',
 description: 'List all Sumo-tracked sessions from the ses: registry. Authoritative: reads the daemon\'s ses: docs, not harness-native thread lists.',
 inputSchema: z.object({
 state: z.string().optional().describe('Filter by session state (e.g. running, ended)')
 }),
 surfaces: ['cli', 'mcp', 'programmatic'],
 /**
 * Read session registry documents from the daemon-owned store.
 *
 * @access public
 * @param {{ state?: string }} input - Validated input for the operation.
 * @returns {Promise<object>} Promise that resolves with the list returned by `exec`.
 */
 async exec(/** @type {{ state?: string }} */ input) {
 const db = await open({});
 try {
 const docs = await scanValues(db, key(''));
 return input?.state ? docs.filter((d) => d.state === input.state): docs;
 } finally {
 await db.close();
 }
 }
 }));

  sumo.command(create({
    name: 'session-cancel',
    title: 'Cancel Session',
    description: 'Interrupt the active work in a running session without ending it. Sends turn/interrupt to a Codex app-server session or SIGINT to a pipe-based session.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id to cancel (ses_...)')
    }),
    annotations: {
      destructiveHint: false,
      idempotentHint: true
    },
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Forward cancellation to the daemon-hosted session controller.
     *
     * @access public
     * @param {{ sessionId: string }} input - Validated input for the operation.
     * @returns {Promise<unknown>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string }} */ input) {
      const db = await open({});
      try {
        return await db.session({
          sessionId: input.sessionId,
          action: 'cancel',
          payload: {}
        });
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-send',
    title: 'Send to Session',
    description: 'Send a text prompt to a running session.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      text: z.string().min(1).describe('Text to send to the session')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Send a prompt turn through the daemon-hosted session controller.
     *
     * @access public
     * @param {{ sessionId: string, text: string }} input - Validated input for the operation.
     * @returns {Promise<unknown>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string, text: string }} */ input) {
      const db = await open({});
      try {
        return await db.session({
          sessionId: input.sessionId,
          action: 'send',
          payload: {
            text: input.text
          }
        });
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-end',
    title: 'End Session',
    description: 'Gracefully end a running session, optionally force-ending it.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      force: z.boolean().optional().describe('Force-kill the session process')
    }),
    annotations: {
      destructiveHint: true,
      idempotentHint: false
    },
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Request daemon-owned session termination.
     *
     * @access public
     * @param {{ sessionId: string, force?: boolean }} input - Validated input for the operation.
     * @returns {Promise<unknown>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string, force?: boolean }} */ input) {
      const db = await open({});
      try {
        return await db.session({
          sessionId: input.sessionId,
          action: 'end',
          payload: {
            force: Boolean(input.force)
          }
        });
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-spawn',
    title: 'Spawn Session',
    description: 'Spawn a new session in the daemon orchestrator. The session handle lives in the daemon and is controllable cross-process.',
    inputSchema: z.object({
      prompt: z.string().describe('The initial prompt for the session'),
      cwd: z.string().optional().describe('Working directory for the session (defaults to current)'),
      harness: z.string().optional().describe('Harness adapter id (e.g. codex, claude-code)'),
      model: z.string().optional().describe('Model id or portable tier (fast, balanced, powerful)'),
      reasoningEffort: z.string().optional().describe('Reasoning effort level (e.g. low, medium, high, xhigh)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Spawn a new daemon-owned session handle.
     *
     * @access public
     * @param {{ prompt: string, cwd?: string, harness?: string, model?: string, reasoningEffort?: string }} input - Validated input for the operation.
     * @param {Record<string, unknown>} ctx - Execution context for the operation.
     * @returns {Promise<unknown>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ prompt: string, cwd?: string, harness?: string, model?: string, reasoningEffort?: string }} */ input, /** @type {Record<string, unknown>} */ ctx) {
      const db = await open({});
      try {
        const cwd = input.cwd ?? (typeof ctx.cwd === 'string' ? ctx.cwd : undefined) ?? process.cwd();
        return await db.session({
          sessionId: '',
          action: 'spawn',
          payload: {
            prompt: input.prompt,
            cwd,
            ...(input.harness ? {
              harness: input.harness
            } : {}),
            ...(input.model ? {
              model: input.model
            } : {}),
            ...(input.reasoningEffort ? {
              reasoningEffort: input.reasoningEffort
            } : {})
          },
          cwd
        });
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-resume',
    title: 'Resume Session',
    description: 'Resume a previous session by its native harness id. The new session handle lives in the daemon orchestrator.',
    inputSchema: z.object({
      resumeId: z.string().min(1).describe('The native harness session id to resume'),
      prompt: z.string().optional().describe('Initial prompt for the resumed session'),
      cwd: z.string().optional().describe('Working directory (defaults to current)'),
      harness: z.string().optional().describe('Harness adapter id (e.g. codex, claude-code)'),
      model: z.string().optional().describe('Model id or portable tier (fast, balanced, powerful)'),
      reasoningEffort: z.string().optional().describe('Reasoning effort level (e.g. low, medium, high, xhigh)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Resume a harness-native session through the daemon orchestrator.
     *
     * @access public
     * @param {{ resumeId: string, prompt?: string, cwd?: string, harness?: string, model?: string, reasoningEffort?: string }} input - Validated input for the operation.
     * @param {Record<string, unknown>} ctx - Execution context for the operation.
     * @returns {Promise<unknown>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ resumeId: string, prompt?: string, cwd?: string, harness?: string, model?: string, reasoningEffort?: string }} */ input, /** @type {Record<string, unknown>} */ ctx) {
      const db = await open({});
      try {
        const cwd = input.cwd ?? (typeof ctx.cwd === 'string' ? ctx.cwd : undefined) ?? process.cwd();
        return await db.session({
          sessionId: '',
          action: 'resume',
          payload: {
            resumeId: input.resumeId,
            prompt: input.prompt ?? '',
            cwd,
            ...(input.harness ? {
              harness: input.harness
            } : {}),
            ...(input.model ? {
              model: input.model
            } : {}),
            ...(input.reasoningEffort ? {
              reasoningEffort: input.reasoningEffort
            } : {})
          },
          cwd
        });
      } finally {
        await db.close();
      }
    }
  }));

  // ── session state-queries (the model-based journey scorers — spec 04 trail,  whole-trail) ──
  // These read the `ses:` doc / event log the daemon owns; they are the decision/outcome nodes a
  // journey graph scores against (a graph becoming a test). A scorer returns `{ pass, message }`.

  sumo.command(create({
    name: 'session-is-running',
    title: 'Session Is Running',
    description: 'Scorer: passes when the session is in the running state and a model was recorded at spawn ().',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      expectModel: z.string().optional().describe('If set, the recorded concrete model must equal this exactly'),
      expectTier: z.enum(['fast', 'balanced', 'powerful']).optional().describe('If set, the recorded portable model tier must equal this exactly')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Score whether the session is running with model metadata recorded.
     *
     * @access public
     * @param {{ sessionId: string, expectModel?: string, expectTier?: string }} input - Validated input for the operation.
     * @returns {Promise<{ pass: boolean, message: string }>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string, expectModel?: string, expectTier?: string }} */ input) {
      const doc = await readSesDoc(input.sessionId);
      if (!doc) return { pass: false, message: `no ses: doc for ${input.sessionId}` };
      const running = doc.state === 'running';
      const modelRecorded = typeof doc.model === 'string' && doc.model.length > 0;
      return {
        pass: running && modelRecorded && modelMatches(doc, input),
        message: `state=${doc.state} model=${doc.model ?? '(none)'} tier=${doc.ext?.tier ?? '(none)'}`
      };
    }
  }));

  sumo.command(create({
    name: 'session-await-ended',
    title: 'Await Session Ended',
    description: 'Task: block until the session reaches a terminal state (ended or dead), or time out. Returns the session id + final state so downstream nodes stay correlated.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      timeoutMs: z.number().int().positive().optional().describe('Max wait (default 180000)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Wait for a session to reach a terminal state.
     *
     * @access public
     * @param {{ sessionId: string, timeoutMs?: number }} input - Validated input for the operation.
     * @returns {Promise<{ sessionId: string, state: string } | import('sumo/error').Result>} Promise that resolves with the shared Result returned by `exec`.
     */
    async exec(/** @type {{ sessionId: string, timeoutMs?: number }} */ input) {
      const timeoutMs = input.timeoutMs ?? 180_000;
      const deadline = Date.now() + timeoutMs;
      const db = await open({});
      try {
        for (;;) {
          const doc = /** @type {SessionDoc|undefined} */ (await db.get(key(input.sessionId)));
          if (doc && (doc.state === 'ended' || doc.state === 'dead')) {
            return {
              sessionId: input.sessionId,
              state: doc.state
            };
          }
          // A timeout is an expected operational failure → the shared Result shape, not a throw (§3b).
          if (Date.now() > deadline) {
            return {
              ok: false,
              code: 'SUMO_VERIFY_FAILED',
              reason: `session ${input.sessionId} did not reach a terminal state within ${timeoutMs}ms`
            };
          }
          await sleep(250);
        }
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-await-turn',
    title: 'Await Session Turn',
    description: 'Task: block until the session has produced at least one assistant turn (an assistant session.message event), or time out. Used to ensure a server-kind session has actually persisted real work before it is ended or resumed — Codex cannot resume from an empty rollout.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      minAssistant: z.number().int().positive().optional().describe('How many assistant turns to wait for (default 1)'),
      timeoutMs: z.number().int().positive().optional().describe('Max wait (default 120000)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Wait until the event log contains the requested assistant turn count.
     *
     * @access public
     * @param {{ sessionId: string, minAssistant?: number, timeoutMs?: number }} input - Validated input for the operation.
     * @returns {Promise<{ sessionId: string, assistantMessages: number } | import('sumo/error').Result>} Promise that resolves with the shared Result returned by `exec`.
     */
    async exec(/** @type {{ sessionId: string, minAssistant?: number, timeoutMs?: number }} */ input) {
      const want = input.minAssistant ?? 1;
      const timeoutMs = input.timeoutMs ?? 120_000;
      const db = await open({});
      try {
        const result = await waitForAssistantMessages(db, input.sessionId, want, timeoutMs);
        if (!result.timeout) {
          return {
            sessionId: input.sessionId,
            assistantMessages: result.count
          };
        }
        // Timeout is an expected operational failure → the shared Result shape, not a throw (§3b).
        return {
          ok: false,
          code: 'SUMO_VERIFY_FAILED',
          reason: `session ${input.sessionId} produced ${result.count}/${want} assistant turn(s) before timeout`
        };
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-await-active-turn',
    title: 'Await Active Session Turn',
    description: 'Task: block until the session emits a turn-started event. Used by live control journeys to prove Codex has an active turn before cancel/interrupt is driven.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      timeoutMs: z.number().int().positive().optional().describe('Max wait (default 30000)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Wait until the event log contains a turn-started event for this session.
     *
     * @access public
     * @param {{ sessionId: string, timeoutMs?: number }} input - Validated input for the operation.
     * @returns {Promise<{ sessionId: string, activeTurns: number, turnId?: string } | import('sumo/error').Result>} Promise that resolves with the shared Result returned by `exec`.
     */
    async exec(/** @type {{ sessionId: string, timeoutMs?: number }} */ input) {
      const timeoutMs = input.timeoutMs ?? 30_000;
      const db = await open({});
      try {
        const result = await waitForActiveTurn(db, input.sessionId, timeoutMs);
        if (!result.timeout) {
          return {
            sessionId: input.sessionId,
            activeTurns: result.count,
            ...(result.turnId ? {
              turnId: result.turnId
            } : {})
          };
        }
        return {
          ok: false,
          code: 'SUMO_VERIFY_FAILED',
          reason: `session ${input.sessionId} emitted ${result.count} turn-started event(s) before timeout`
        };
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-await-turn-completed',
    title: 'Await Session Turn Completed',
    description: 'Task: block until a Codex turn-completed event lands. If a turn id is threaded in, waits for that exact turn.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      turnId: z.string().optional().describe('Specific turn id to wait for'),
      turn: z.object({
        id: z.string().optional()
      }).passthrough().optional().describe('Turn object returned by Codex turn/start'),
      timeoutMs: z.number().int().positive().optional().describe('Max wait (default 120000)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Wait until the event log contains a turn-completed event for this session.
     *
     * @access public
     * @param {{ sessionId: string, turnId?: string, turn?: { id?: string }, timeoutMs?: number }} input - Validated input for the operation.
     * @returns {Promise<{ sessionId: string, completedTurns: number, turnId?: string, status?: string } | import('sumo/error').Result>} Promise that resolves with the shared Result returned by `exec`.
     */
    async exec(/** @type {{ sessionId: string, turnId?: string, turn?: { id?: string }, timeoutMs?: number }} */ input) {
      const timeoutMs = input.timeoutMs ?? 120_000;
      const wantTurnId = input.turn?.id ?? input.turnId;
      const db = await open({});
      try {
        const result = await waitForTurnCompleted(db, input.sessionId, wantTurnId, timeoutMs);
        if (result.unavailableCode) {
          return {
            ok: false,
            code: result.unavailableCode,
            reason: `session ${input.sessionId} live prerequisite unavailable: ${result.unavailableCode}`
          };
        }
        if (!result.timeout) {
          return {
            sessionId: input.sessionId,
            completedTurns: result.count,
            ...(result.turnId ? {
              turnId: result.turnId
            } : {}),
            ...(result.status ? {
              status: result.status
            } : {})
          };
        }
        const suffix = wantTurnId ? ` for turn ${wantTurnId}` : '';
        return {
          ok: false,
          code: 'SUMO_VERIFY_FAILED',
          reason: `session ${input.sessionId} emitted ${result.count} turn-completed event(s)${suffix} before timeout`
        };
      } finally {
        await db.close();
      }
    }
  }));

 sumo.command(create({
 name: 'session-transcript-correlated',
 title: 'Transcript Correlated',
 description: 'Scorer: passes when the session doc correlates to its on-disk transcript (native id + path), and re-ingesting that transcript COLLAPSES onto the live stream (dual-source dedupe) rather than duplicating turns.',
 inputSchema: z.object({
 sessionId: z.string().min(1).describe('The Sumo session id (ses_...)')
 }),
 surfaces: ['cli', 'mcp', 'programmatic'],
 /**
 * Verify transcript correlation and idempotent re-ingestion collapse for a session.
 *
 * @access public
 * @param {{ sessionId: string }} input - Validated input for the operation.
 * @returns {Promise<{ pass: boolean, message: string }>} Promise resolving to the `exec` result.
 */
 async exec(/** @type {{ sessionId: string }} */ input) {
 const doc = await readSesDoc(input.sessionId);
 if (!doc) {
 return {
 pass: false,
 message: `no ses: doc for ${input.sessionId}`
 };
 }
 if (typeof doc.transcriptPath !== 'string' || typeof doc.harnessSessionId !== 'string' || !doc.harnessSessionId) {
 return {
 pass: false,
 message: `not correlated: transcriptPath=${doc.transcriptPath} native=${doc.harnessSessionId}`
 };
 }
 if (!doc.transcriptPath.endsWith(`${doc.harnessSessionId}.jsonl`)) {
 return {
 pass: false,
 message: `transcript path missing or misnamed: ${doc.transcriptPath}`
 };
 }
 let records;
 try {
 records = readJsonl(doc.transcriptPath);
 } catch (err) {
 if (/** @type {Record<string, unknown>} */ (err)?.code) {
 return {
 pass: false,
 message: `transcript path missing or misnamed: ${doc.transcriptPath}`
 };
 }
 throw err;
 }
 const Artifacts = typeof doc.harness === 'string' ? adapters[doc.harness]: undefined;
 if (!Artifacts) {
 return {
 pass: false,
 message: `cannot verify transcript dedupe: no acquirer for '${doc.harness}'`
 };
 }
 // Deliberate side effect: this scorer INGESTS the on-disk transcript (the daemon appends its
 // events) so the collapse is observable — that is the only way to witness dual-source dedupe
 // live. The daemon collapses by shared key, so re-ingestion is idempotent on the turn records.
 const db = await open({});
 try {
 const before = await countAssistantMessages(db, input.sessionId);
 // Guard the vacuous pass: with no live-stream assistant message there is nothing to collapse
 // onto, so `before===after===0` must NOT read as "deduped".
 if (before < 1) {
 return {
 pass: false,
 message: 'no live-stream assistant message present — nothing to dedupe against'
 };
 }
 const result = await new Artifacts().import(records, {
 db: /** @type {{ append: (event: Record<string, unknown>) => Promise<unknown>, mergeDoc?: (key: string, patch: Record<string, unknown>) => Promise<unknown> }} */ (/** @type {unknown} */ (db)),
 sessionId: input.sessionId
 });
 if (result && result.ok === false) {
 return {
 pass: false,
 message: `transcript import failed: ${result.reason}`
 };
 }
 const after = await countAssistantMessages(db, input.sessionId);
 return {
 pass: after === before,
 message: `assistant messages before=${before} after re-ingest=${after} (collapsed when equal)`
 };
 } finally {
 await db.close();
 }
 }
 }));

  sumo.command(create({
    name: 'session-events-correlated',
    title: 'Session Events Correlated',
    description: 'Scorer: passes when the LIVE event stream is Sumo-keyed — at least one evt: event carries sessionId === the Sumo ulid AND records the harness-native id in ext.nativeSessionId. This is the honest correlation assertion for server-kind harnesses (Codex), where transcriptPath is filled later by the agent-artifacts acquirer on tail-discovery, not at spawn, so the transcript+dedupe scorer does not apply.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)'),
      timeoutMs: z.number().int().positive().optional().describe('Max wait for the first keyed event (default 15000)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Wait briefly for the live event stream to carry Sumo and harness-native ids together.
     *
     * @access public
     * @param {{ sessionId: string, timeoutMs?: number }} input - Validated input for the operation.
     * @returns {Promise<{ pass: boolean, message: string }>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string, timeoutMs?: number }} */ input) {
      // The event stream is appended asynchronously by the harness read loop, so subscribe briefly for
      // the first Sumo-keyed event rather than racing a single read. Bounded; a timeout is a clean fail.
      const timeoutMs = input.timeoutMs ?? 15_000;
      const db = await open({});
      try {
        const result = await waitForCorrelatedEvents(db, input.sessionId, timeoutMs);
        if (result.pass) {
          return {
            pass: true,
            message: `events keyed=${result.keyed} withNativeId=${result.withNative}`
          };
        }
        return {
          pass: false,
          message: `live stream not correlated within budget: keyed=${result.keyed} withNativeId=${result.withNative}`
        };
      } finally {
        await db.close();
      }
    }
  }));

  sumo.command(create({
    name: 'session-native-id',
    title: 'Session Native Id',
    description: 'Task: surface a session\'s harness-native id as { resumeId } so a downstream resume node can thread it. The native id is generated by the harness at runtime and cannot be hardcoded in a journey, so a model-based test reads it from the ses: doc and threads it into session-resume.',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Surface a session's harness-native id for downstream resume nodes.
     *
     * @access public
     * @param {{ sessionId: string }} input - Validated input for the operation.
     * @returns {Promise<{ resumeId: string } | import('sumo/error').Result>} Promise that resolves with the shared Result returned by `exec`.
     */
    async exec(/** @type {{ sessionId: string }} */ input) {
      const doc = await readSesDoc(input.sessionId);
      // Expected operational failure → the shared Result shape, not a throw (§3b). A journey node
      // unwraps this and fails loudly if the native id was never recorded.
      if (!doc || typeof doc.harnessSessionId !== 'string' || !doc.harnessSessionId) {
        return {
          ok: false,
          code: 'SUMO_VERIFY_FAILED',
          reason: `no native harness id recorded for ${input.sessionId}`
        };
      }
      return {
        resumeId: doc.harnessSessionId
      };
    }
  }));

  sumo.command(create({
    name: 'session-completed',
    title: 'Session Completed',
    description: 'Scorer: passes when the session has ended cleanly (state ended).',
    inputSchema: z.object({
      sessionId: z.string().min(1).describe('The Sumo session id (ses_...)')
    }),
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Score clean session completion from the daemon registry state.
     *
     * @access public
     * @param {{ sessionId: string }} input - Validated input for the operation.
     * @returns {Promise<{ pass: boolean, message: string }>} Promise resolving to the `exec` result.
     */
    async exec(/** @type {{ sessionId: string }} */ input) {
      const doc = await readSesDoc(input.sessionId);
      if (!doc) {
        return {
          pass: false,
          message: `no ses: doc for ${input.sessionId}`
        };
      }
      return {
        pass: doc.state === 'ended',
        message: `state=${doc.state}`
      };
    }
  }));
}
/** Built-in registration is safe to request from both a programmatic host and the runtime. */
const registeredFacades = new WeakSet;
