/**
 * Runtime engine for `opportunist`.
 *
 * @module sumo/plugins/opportunist/engine
 */
/* eslint-disable jsdoc/match-description, jsdoc/require-param-description, jsdoc/require-returns-description */

import { detectText, verificationId } from './detect.mjs';
import { FindingsInput, ResolveInput } from './config.mjs';
import { parseResultBlock, parseTriageBlock, repairPrompt, triagePrompt } from './prompt.mjs';

const RECENT_LIMIT = 25;

/**
 * @typedef {{ seq?: number, type: string, ts?: number, payload?: Record<string, unknown>, sessionId?: string }} SumoEvent
 * @typedef {{ get: (key: string) => Promise<unknown>, set: (key: string, value: unknown) => Promise<void>, scan: (prefix: string) => AsyncIterable<[string, unknown]> }} Store
 * @typedef {{ id: string, join: () => AsyncIterable<SumoEvent>, done: () => Promise<unknown>, end?: (opts?: Record<string, unknown>) => Promise<unknown> }} ChildSession
 * @typedef {{
 *   command: (name: string, fn: (input?: unknown) => unknown, schema?: unknown) => void,
 *   emit: (type: string, payload?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<number>,
 *   on: (type: string, fn: (event: SumoEvent) => unknown) => void,
 *   run: (prompt: string, opts?: Record<string, unknown>) => Promise<{ ok: true, value: ChildSession } | { ok: false, code?: string, reason?: string }>,
 *   store: (ns: string) => Store
 * }} SumoFacade
 * @typedef {{ enabled: boolean, harness: string|null, tier: string|null, model: string|null, prompts: { triage: string|null, repair: string|null } }} OpportunistOptions
 */

/**
 * Register Opportunist commands and event observers.
 *
 * @access public
 * @param {SumoFacade} sumo - Sumo plugin facade.
 * @param {OpportunistOptions} cfg - Parsed plugin config.
 * @returns {void} Registers runtime behavior.
 */
export function registerOpportunistEngine(sumo, cfg) {
  const store = sumo.store('findings');
  /** @type {Set<string>} */
  const terminal = new Set();
  /** @type {Set<string>} */
  const owned = new Set();
  /** @type {Set<string>} */
  const triaging = new Set();
  const deps = { sumo, store, cfg, terminal, owned, triaging };

  sumo.command('opportunist-findings', async (input = {}) => {
    const args = FindingsInput.parse(input);
    const findings = [];
    for await (const [, value] of store.scan('finding:')) {
      const finding = /** @type {Record<string, unknown>} */ (value);
      if (args.state && finding.state !== args.state) continue;
      if (args.sessionId && finding.sessionId !== args.sessionId) continue;
      findings.push(finding);
    }
    findings.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    return { findings };
  }, FindingsInput);

  sumo.command('opportunist-resolve', async (input = {}) => {
    const args = ResolveInput.parse(input);
    const current = await store.get(`finding:${args.id}`);
    if (!current) return { ok: false, reason: `finding not found: ${args.id}` };
    const resolved = resolvedFinding(/** @type {Record<string, unknown>} */ (current), args.status, args.evidence);
    await store.set(`finding:${args.id}`, resolved);
    await sumo.emit('opportunist.repair-resolved', eventPayload(resolved), { dedupe: `opportunist:resolved:${args.id}` });
    return resolved;
  }, ResolveInput);

  if (!cfg.enabled) return;

  sumo.on('session.started', (event) => recordRecent(store, event));
  sumo.on('session.turn-completed', (event) => stableSession(deps, event));
  sumo.on('session.idle', (event) => stableSession(deps, event));
  sumo.on('session.ended', (event) => {
    const sessionId = sessionIdOf(event);
    if (sessionId) terminal.add(sessionId);
    return stableSession(deps, event);
  });
  sumo.on('session.dead', (event) => {
    const sessionId = sessionIdOf(event);
    if (sessionId) terminal.add(sessionId);
    return stableSession(deps, event);
  });
  sumo.on('session.reasoning', (event) => observeText(deps, event, 'reasoning'));
  sumo.on('session.message', (event) => {
    if (event.payload?.role !== 'assistant') return recordRecent(store, event);
    return observeText(deps, event, 'message');
  });
  sumo.on('session.tool', (event) => observeTool(deps, event));
}

/**
 * Observe one text-bearing event.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store, cfg: OpportunistOptions, terminal: Set<string>, owned: Set<string>, triaging: Set<string> }} deps
 * @param {SumoEvent} event
 * @param {string} source
 * @returns {Promise<void>}
 */
async function observeText(deps, event, source) {
  await recordRecent(deps.store, event);
  const sessionId = sessionIdOf(event);
  if (!sessionId || deps.terminal.has(sessionId) || deps.owned.has(sessionId)) return;
  const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
  if (!text) return;
  for (const finding of detectText({ text, source, sessionId, sourceEventSeq: event.seq })) {
    await recordFinding(deps, finding);
  }
}

/**
 * Observe a tool event for verification failures or passes.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store, cfg: OpportunistOptions, terminal: Set<string>, owned: Set<string>, triaging: Set<string> }} deps
 * @param {SumoEvent} event
 * @returns {Promise<void>}
 */
async function observeTool(deps, event) {
  await recordRecent(deps.store, event);
  const sessionId = sessionIdOf(event);
  if (!sessionId || deps.terminal.has(sessionId) || deps.owned.has(sessionId)) return;
  const tool = event.payload?.tool && typeof event.payload.tool === 'object' ? /** @type {Record<string, unknown>} */ (event.payload.tool) : {};
  const command = commandOf(tool);
  if (!command || !verificationCommand(command)) return;
  const failed = toolFailed(tool);
  const key = `finding:${verificationId({ sessionId, command })}`;
  if (!failed) {
    const current = await deps.store.get(key);
    if (current && /** @type {Record<string, unknown>} */ (current).kind === 'verification') {
      await deps.store.set(key, resolvedFinding(/** @type {Record<string, unknown>} */ (current), 'fixed', `green rerun: ${command}`));
    }
    return;
  }
  await recordFinding(deps, {
    id: verificationId({ sessionId, command }),
    kind: 'verification',
    state: 'open',
    sessionId,
    command,
    snippet: `Verification command failed: ${command}`,
    sourceEventSeq: event.seq,
    createdAt: Date.now()
  });
}

/**
 * Record a new finding without starting repair while the parent session is still active.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store }} deps
 * @param {Record<string, unknown>} finding
 * @returns {Promise<void>}
 */
async function recordFinding(deps, finding) {
  const key = `finding:${finding.id}`;
  const existing = await deps.store.get(key);
  if (existing) return;

  const now = Date.now();
  const recentEvents = await recent(deps.store, String(finding.sessionId ?? ''));
  const record = {
    ...finding,
    state: 'open',
    createdAt: finding.createdAt ?? now,
    updatedAt: now,
    recentEvents
  };
  await deps.store.set(key, record);
  await deps.sumo.emit('opportunist.finding-detected', eventPayload(record), eventOptions(`opportunist:finding:${finding.id}`, finding.sessionId));
}

/**
 * Trigger triage after a parent session reaches a stable point.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store, cfg: OpportunistOptions, owned: Set<string>, triaging: Set<string> }} deps
 * @param {SumoEvent} event
 * @returns {Promise<void>}
 */
async function stableSession(deps, event) {
  await recordRecent(deps.store, event);
  const sessionId = sessionIdOf(event);
  if (!sessionId || deps.owned.has(sessionId) || deps.triaging.has(sessionId)) return;
  const findings = await openFindings(deps.store, sessionId);
  if (findings.length === 0) return;
  deps.triaging.add(sessionId);
  void triageFindings(deps, sessionId, findings, event).finally(() => deps.triaging.delete(sessionId));
}

/**
 * Spawn and monitor a triage session for all open findings in a parent session.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store, cfg: OpportunistOptions, owned: Set<string> }} deps
 * @param {string} sessionId
 * @param {Array<Record<string, unknown>>} findings
 * @param {SumoEvent} event
 * @returns {Promise<void>}
 */
async function triageFindings(deps, sessionId, findings, event) {
  const recentEvents = await recent(deps.store, sessionId);
  const cwd = cwdOf(event, recentEvents);
  const result = await deps.sumo.run(triagePrompt({
    findings,
    recentEvents,
    cwd,
    config: publicConfig(deps.cfg),
    templatePath: deps.cfg.prompts.triage
  }), spawnOpts(deps.cfg, sessionId, cwd));
  if (!result.ok) {
    await markInconclusiveAll(deps, findings, { stage: 'triage', code: result.code, reason: result.reason });
    return;
  }

  const child = result.value;
  deps.owned.add(child.id);
  const startedAt = Date.now();
  for (const finding of findings) {
    await deps.store.set(`finding:${finding.id}`, {
      ...finding,
      updatedAt: startedAt,
      triageSessionId: child.id,
      triageStartedAt: startedAt
    });
  }
  await deps.sumo.emit('opportunist.triage-started', {
    sessionId,
    triageSessionId: child.id,
    findingIds: findings.map((finding) => finding.id)
  }, eventOptions(`opportunist:triage-started:${sessionId}:${startedAt}`, sessionId));

  let parsed = null;
  for await (const childEvent of child.join()) {
    const text = childText(childEvent);
    if (!text) continue;
    parsed = parseTriageBlock(text);
    if (parsed) break;
  }
  if (!parsed) {
    await child.done().catch(() => {});
    await markInconclusiveAll(deps, findings, { stage: 'triage', reason: 'triage session ended without a valid OPPORTUNIST_TRIAGE block', triageSessionId: child.id });
    return;
  }

  const byId = new Map(parsed.decisions.map((decision) => [decision.id, decision]));
  for (const finding of findings) {
    const current = /** @type {Record<string, unknown>|undefined} */ (await deps.store.get(`finding:${finding.id}`)) ?? finding;
    if (current.state !== 'open') continue;
    const decision = byId.get(String(finding.id));
    if (!decision) {
      await markInconclusive(deps, current, { stage: 'triage', reason: 'triage omitted a decision for this finding', triageSessionId: child.id });
      continue;
    }
    if (decision.action === 'repair') {
      await repairFinding(deps, {
        ...current,
        triageSessionId: child.id,
        triageReason: decision.reason
      }, event, decision.prompt ?? decision.reason);
      continue;
    }
    const resolved = resolvedFinding({
      ...current,
      triageSessionId: child.id,
      triageReason: decision.reason
    }, decision.action, decision.reason);
    await deps.store.set(`finding:${finding.id}`, resolved);
    await deps.sumo.emit('opportunist.repair-resolved', eventPayload(resolved), eventOptions(`opportunist:resolved:${finding.id}`, sessionId));
  }
  void child.end?.({ force: false }).catch(() => {});
}

/**
 * Spawn and monitor a repair session.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store, cfg: OpportunistOptions, owned: Set<string> }} deps
 * @param {Record<string, unknown>} finding
 * @param {SumoEvent} event
 * @param {string} triageInstruction
 * @returns {Promise<void>}
 */
async function repairFinding(deps, finding, event, triageInstruction) {
  const sessionId = String(finding.sessionId ?? '');
  const recentEvents = await recent(deps.store, sessionId);
  const cwd = cwdOf(event, recentEvents);
  const result = await deps.sumo.run(repairPrompt({
    finding,
    recentEvents,
    cwd,
    config: publicConfig(deps.cfg),
    templatePath: deps.cfg.prompts.repair,
    triageInstruction
  }), spawnOpts(deps.cfg, sessionId, cwd));
  if (!result.ok) {
    await markInconclusive(deps, finding, { stage: 'repair', code: result.code, reason: result.reason });
    return;
  }

  const child = result.value;
  deps.owned.add(child.id);
  const running = {
    ...finding,
    state: 'running',
    updatedAt: Date.now(),
    repairSessionId: child.id,
    repairStartedAt: Date.now()
  };
  await deps.store.set(`finding:${finding.id}`, running);
  await deps.sumo.emit('opportunist.repair-started', eventPayload(running), eventOptions(`opportunist:started:${finding.id}`, sessionId));

  let parsed = null;
  for await (const childEvent of child.join()) {
    const text = childText(childEvent);
    if (!text) continue;
    parsed = parseResultBlock(text);
    if (parsed) break;
  }
  if (!parsed) {
    await child.done().catch(() => {});
    await markInconclusive(deps, running, { stage: 'repair', reason: 'repair session ended without a valid OPPORTUNIST_RESULT block', repairSessionId: child.id });
    return;
  }
  const resolved = resolvedFinding(running, parsed.status, parsed.evidence);
  await deps.store.set(`finding:${finding.id}`, resolved);
  await deps.sumo.emit('opportunist.repair-resolved', eventPayload(resolved), eventOptions(`opportunist:resolved:${finding.id}`, sessionId));
  void child.end?.({ force: false }).catch(() => {});
}

/**
 * Extract child assistant text from normalized message/final-answer events.
 *
 * @access private
 * @param {SumoEvent} event
 * @returns {string}
 */
function childText(event) {
  if (event.type === 'session.final-answer' && typeof event.payload?.text === 'string') return event.payload.text;
  if (event.type === 'session.message' && event.payload?.role === 'assistant' && typeof event.payload.text === 'string') return event.payload.text;
  return '';
}

/**
 * Mark repair or triage inconclusive while keeping the finding open.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store }} deps
 * @param {Record<string, unknown>} finding
 * @param {Record<string, unknown>} detail
 * @returns {Promise<void>}
 */
async function markInconclusive(deps, finding, detail) {
  const current = /** @type {Record<string, unknown>|undefined} */ (await deps.store.get(`finding:${finding.id}`)) ?? finding;
  const next = {
    ...current,
    state: 'open',
    updatedAt: Date.now(),
    repairEndedAt: detail.stage === 'repair' ? Date.now() : current.repairEndedAt,
    lastRepairSessionId: detail.repairSessionId ?? current.repairSessionId,
    spawnFailure: detail.stage === 'repair' && (detail.code || detail.reason) ? { code: detail.code, reason: detail.reason } : current.spawnFailure,
    triageFailure: detail.stage === 'triage' && (detail.code || detail.reason) ? { code: detail.code, reason: detail.reason } : current.triageFailure
  };
  await deps.store.set(`finding:${finding.id}`, next);
  await deps.sumo.emit('opportunist.repair-inconclusive', { ...eventPayload(next), detail }, eventOptions(`opportunist:inconclusive:${finding.id}:${Date.now()}`, finding.sessionId));
}

/**
 * Mark a group of findings inconclusive.
 *
 * @access private
 * @param {{ sumo: SumoFacade, store: Store }} deps
 * @param {Array<Record<string, unknown>>} findings
 * @param {Record<string, unknown>} detail
 * @returns {Promise<void>}
 */
async function markInconclusiveAll(deps, findings, detail) {
  for (const finding of findings) {
    await markInconclusive(deps, finding, detail);
  }
}

/**
 * Create a resolved finding record.
 *
 * @access private
 * @param {Record<string, unknown>} finding
 * @param {string} status
 * @param {string} evidence
 * @returns {Record<string, unknown>}
 */
function resolvedFinding(finding, status, evidence) {
  const now = Date.now();
  return {
    ...finding,
    state: 'resolved',
    updatedAt: now,
    repairEndedAt: now,
    resolutionStatus: status,
    evidence
  };
}

/**
 * Read all open findings for a session.
 *
 * @access private
 * @param {Store} store
 * @param {string} sessionId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function openFindings(store, sessionId) {
  const findings = [];
  for await (const [, value] of store.scan('finding:')) {
    const finding = /** @type {Record<string, unknown>} */ (value);
    if (finding.sessionId === sessionId && finding.state === 'open' && !finding.triageFailure && !finding.triageSessionId && !finding.repairSessionId) findings.push(finding);
  }
  findings.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  return findings;
}

/**
 * Build child session options for triage and repair agents.
 *
 * @access private
 * @param {OpportunistOptions} cfg
 * @param {string} sessionId
 * @param {string|undefined} cwd
 * @returns {Record<string, unknown>}
 */
function spawnOpts(cfg, sessionId, cwd) {
  return {
    spawnKey: `opportunist:${sessionId}`,
    ...(cfg.harness ? { harness: cfg.harness } : {}),
    ...(cfg.tier || cfg.model ? { model: cfg.tier ?? cfg.model } : {}),
    ...(cwd ? { cwd } : {})
  };
}

/**
 * Render a prompt-safe copy of plugin config.
 *
 * @access private
 * @param {OpportunistOptions} cfg
 * @returns {Record<string, unknown>}
 */
function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    harness: cfg.harness,
    tier: cfg.tier,
    model: cfg.model,
    prompts: cfg.prompts
  };
}

/**
 * Record a bounded recent-event buffer.
 *
 * @access private
 * @param {Store} store
 * @param {SumoEvent} event
 * @returns {Promise<void>}
 */
async function recordRecent(store, event) {
  const sessionId = sessionIdOf(event);
  if (!sessionId) return;
  const key = `recent:${sessionId}`;
  const existing = await store.get(key);
  const list = Array.isArray(existing) ? existing : [];
  const compact = {
    seq: event.seq,
    type: event.type,
    ts: event.ts,
    payload: compactPayload(event.payload)
  };
  await store.set(key, [...list, compact].slice(-RECENT_LIMIT));
}

/**
 * Read recent events for a session.
 *
 * @access private
 * @param {Store} store
 * @param {string} sessionId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function recent(store, sessionId) {
  const value = await store.get(`recent:${sessionId}`);
  return Array.isArray(value) ? value : [];
}

/**
 * Return event payload without large tool output.
 *
 * @access private
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function compactPayload(payload = {}) {
  const out = { ...payload };
  if (typeof out.text === 'string') out.text = out.text.slice(0, 500);
  if (out.tool && typeof out.tool === 'object') {
    const tool = /** @type {Record<string, unknown>} */ (out.tool);
    out.tool = {
      name: tool.name,
      input: tool.input,
      ...(typeof tool.output === 'string' ? { output: tool.output.slice(0, 1500) } : {}),
      exitCode: tool.exitCode,
      status: tool.status
    };
  }
  return out;
}

/**
 * Build a public event payload from a finding.
 *
 * @access private
 * @param {Record<string, unknown>} finding
 * @returns {Record<string, unknown>}
 */
function eventPayload(finding) {
  return {
    id: finding.id,
    kind: finding.kind,
    state: finding.state,
    sessionId: finding.sessionId,
    phrase: finding.phrase,
    command: finding.command,
    snippet: finding.snippet,
    triageSessionId: finding.triageSessionId,
    repairSessionId: finding.repairSessionId,
    resolutionStatus: finding.resolutionStatus,
    evidence: finding.evidence
  };
}

/**
 * Build emit options with a session id only when one is known.
 *
 * @access private
 * @param {string} dedupe
 * @param {unknown} sessionId
 * @returns {{ dedupe: string, sessionId?: string }}
 */
function eventOptions(dedupe, sessionId) {
  return typeof sessionId === 'string' && sessionId ? { dedupe, sessionId } : { dedupe };
}

/**
 * Resolve repository cwd from the triggering event or recent session trace.
 *
 * @access private
 * @param {SumoEvent} event
 * @param {Array<Record<string, unknown>>} recentEvents
 * @returns {string|undefined}
 */
function cwdOf(event, recentEvents) {
  if (typeof event.payload?.cwd === 'string') return event.payload.cwd;
  for (let i = recentEvents.length - 1; i >= 0; i -= 1) {
    const payload = recentEvents[i]?.payload;
    if (payload && typeof payload === 'object' && typeof /** @type {Record<string, unknown>} */ (payload).cwd === 'string') return /** @type {string} */ (/** @type {Record<string, unknown>} */ (payload).cwd);
  }
  return undefined;
}

/**
 * Resolve session id from top-level event or payload.
 *
 * @access private
 * @param {SumoEvent} event
 * @returns {string|undefined}
 */
function sessionIdOf(event) {
  return typeof event.sessionId === 'string' ? event.sessionId : typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : undefined;
}

/**
 * Extract a shell command from a normalized tool payload.
 *
 * @access private
 * @param {Record<string, unknown>} tool
 * @returns {string}
 */
function commandOf(tool) {
  const input = tool.input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (input);
  return typeof record.command === 'string' ? record.command : typeof record.cmd === 'string' ? record.cmd : '';
}

/**
 * Conservative verification-command classifier.
 *
 * @access private
 * @param {string} command
 * @returns {boolean}
 */
function verificationCommand(command) {
  return /\b(pnpm|npm|node)\s+(test|run\s+(test|lint|typecheck|test:unit|test:coverage))\b/.test(command) || /\bnode\s+--test\b/.test(command);
}

/**
 * Read failure state from common normalized tool fields.
 *
 * @access private
 * @param {Record<string, unknown>} tool
 * @returns {boolean}
 */
function toolFailed(tool) {
  if (typeof tool.exitCode === 'number') return tool.exitCode !== 0;
  if (typeof tool.status === 'string') return ['failed', 'error', 'timed_out', 'timeout'].includes(tool.status);
  const output = tool.output && typeof tool.output === 'object' ? /** @type {Record<string, unknown>} */ (tool.output) : {};
  if (typeof output.exitCode === 'number') return output.exitCode !== 0;
  if (typeof output.status === 'string') return ['failed', 'error', 'timed_out', 'timeout'].includes(output.status);
  const text = typeof tool.output === 'string' ? tool.output : typeof output.text === 'string' ? output.text : '';
  if (text && /\b(fail(?:ed|ing|ure)?|not ok|ERR!|AssertionError|tests?\s+failed)\b/i.test(text)) return true;
  return false;
}
