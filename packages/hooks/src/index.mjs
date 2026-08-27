/**
 * `sumo/hooks` — the thin shared layer behind the `sumo forward <harness> <nativeEvent>` CLI command
 * (spec 12, ). It holds NO decision logic and NO per-harness schema: it classifies a native hook
 * event (observe vs decide), drives a DECISION hook through the injected `steer` (the daemon-hosted
 * waterfall), and dispatches the pure parse/format to the harness adapter (`toNativeRequest` /
 * `toNativeResponse`). The rich `SumoDecisionIntent` vocabulary is deliberately NOT built here — the
 * 1.0 carries the engine's existing `{ event } | { deny }` end to end.
 *
 * @module sumo/hooks
 */

import { randomUUID } from 'node:crypto';
import { adapters } from 'sumo/harness';
import { forEvent } from 'sumo/db/dedupe';

/**
 * @typedef {{ kind: 'observe'|'decide', action?: string }} HookRoute
 * @typedef {{ action: string, payload: Record<string, unknown>, ext: Record<string, unknown> & { nativeSessionId?: string } }} HookRequest
 * @typedef {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} HookResponse
 * @typedef {{ type: string, payload: Record<string, unknown>, ext: Record<string, unknown>, sessionId?: string, id?: string }} HookObservation
 * @typedef {{
 *   hookEvents: Record<string, HookRoute>,
 *   toNativeRequest: (nativeEvent: string, payload: Record<string, unknown>) => HookRequest,
 *   toNativeResponse: (decision: Record<string, unknown>, nativeEvent: string, payload: Record<string, unknown>) => HookResponse,
 *   toObservation: (nativeEvent: string, payload: Record<string, unknown>) => HookObservation|undefined
 * }} HookAdapter
 * @typedef {{ new (): HookAdapter }} HookAdapterConstructor
 * @typedef {(decision: {
 *   harness: string,
 *   cwd: string,
 *   action: string,
 *   payload: Record<string, unknown>,
 *   ext: Record<string, unknown>,
 *   nativeSessionId?: string
 * }) => Promise<Record<string, unknown>>} SteerFunction
 * @typedef {(input: { adapter: HookAdapter, nativeEvent: string, payload: Record<string, unknown>, rawPayloadText?: string }) => Promise<void>} ObserveFunction
 * @typedef {{ put: (key: string, value: unknown) => Promise<void>, append: (event: Record<string, unknown>) => Promise<void> }} HookDb
 */

/**
 * Classify a native hook event for an adapter. An event the adapter does not map is treated as an
 * observation (§3e — surfaced/passed through, never crashed).
 *
 * @access public
 * @param {HookAdapter} adapter - Harness adapter that owns the native event mapping.
 * @param {string} nativeEvent - Native hook event name.
 * @returns {HookRoute} Structured output from `classify`.
 */
export function classify(adapter, nativeEvent) {
  return adapter.hookEvents[nativeEvent] ?? { kind: 'observe' };
}

/**
 * Run one forwarded hook. Pure orchestration over injected effects so it is unit-testable without a
 * daemon: `steer` drives a decision hook; `observe` ingests an observation hook (wired in Step 5).
 *
 * @access public
 * @param {{ harness: string, nativeEvent: string, payloadText?: string, cwd: string, steer: SteerFunction, safety?: boolean, observe?: ObserveFunction }} args - Forwarded hook invocation and injected effects.
 * @returns {Promise<{ kind: 'observe'|'decide'|'noop', stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }>} Promise that resolves with the list returned by `forward`.
 */
export async function forward({ harness, nativeEvent, payloadText, cwd, steer, safety = false, observe }) {
  const Adapter = /** @type {Record<string, HookAdapterConstructor>} */ (/** @type {unknown} */ (adapters))[harness];
  if (!Adapter) {
    return { kind: 'noop', stdout: '', exitCode: 0, diagnostics: [{ code: 'SUMO_BAD_HARNESS', message: `unknown harness '${harness}'` }] };
  }
  const adapter = new Adapter();

  // Parse the native payload. Malformed JSON is not fatal: the observe path still surfaces the raw
  // text (§3e), and a decision hook degrades to an empty payload rather than crashing the agent.
  /** @type {Record<string, unknown>} */
  let payload = {};
  const diagnostics = [];
  if (payloadText && payloadText.trim()) {
    try {
      payload = /** @type {Record<string, unknown>} */ (JSON.parse(payloadText));
    } catch (err) {
      diagnostics.push({ code: 'SUMO_HOOK_PAYLOAD_INVALID', message: `could not parse ${harness} ${nativeEvent} payload: ${err?.message ?? err}` });
    }
  }

 // §3e — EVERY hook surfaces onto the event stream, decision OR observation. A denied PreToolUse
 // still leaves an auditable tool event + raw payload. A failed ingest is recorded as a diagnostic
 // but NEVER crashes the agent's hook.
 if (observe) {
 try {
 await observe({ adapter, nativeEvent, payload, rawPayloadText: payloadText });
 } catch (err) {
 diagnostics.push({ code: 'SUMO_HOOK_OBSERVE_FAILED', message: `observation ingest failed for ${harness} ${nativeEvent}: ${err?.message ?? err}` });
 }
 }

  const route = classify(adapter, nativeEvent);
  if (route.kind !== 'decide') {
    return { kind: 'observe', stdout: '', exitCode: 0, diagnostics };
  }

  const req = adapter.toNativeRequest(nativeEvent, payload);
  let decision;
  try {
    decision = await steer({
      harness, cwd, action: req.action, payload: req.payload, ext: req.ext,
      // Thread the normalized native session id (if the adapter extracted one) so the
      // daemon-side steer-host can correlate it to the Sumo ULID.
      ...(req.ext.nativeSessionId ? { nativeSessionId: req.ext.nativeSessionId } : {})
    });
  } catch (err) {
    // The daemon is unreachable or the project runtime is not ready. The plugin handler's own
    // `opts.safety` is out of reach here, so the install-encoded per-hook `safety` flag decides:
    // safety → fail CLOSED (native deny), non-safety → fail OPEN (allow). Never crash the agent.
    const errorRecord = err && typeof err === 'object' ? /** @type {Record<string, unknown>} */ (err) : undefined;
    const diag = {
      code: typeof errorRecord?.code === 'string' ? errorRecord.code : 'SUMO_STEER_UNREACHABLE',
      message: `steer unreachable for ${harness} ${nativeEvent}: ${errorRecord?.message ?? err}`
    };
    if (safety) {
      const res = adapter.toNativeResponse({ deny: 'Sumo steering unavailable — failing closed (safety hook)' }, nativeEvent, payload);
      return { kind: 'decide', stdout: res.stdout, exitCode: res.exitCode, diagnostics: [...diagnostics, diag, ...res.diagnostics] };
    }
    return { kind: 'decide', stdout: '', exitCode: 0, diagnostics: [...diagnostics, diag] };
  }
  const res = adapter.toNativeResponse(decision, nativeEvent, payload);
  return { kind: 'decide', stdout: res.stdout, exitCode: res.exitCode, diagnostics: [...diagnostics, ...res.diagnostics] };
}

/**
 * Ingest an OBSERVATION hook onto the event stream (spec 12). Normalizes via the adapter so the event
 * collapses with the transcript-sourced one on the shared dedupe key (), and applies
 * REDACT-BEFORE-APPEND: the raw native payload is stored under a `raw:` key (where the
 * daemon's `redactRawValue` runs) and referenced by `rawRef` — it is NEVER placed in `evt.ext`.
 * An un-normalizable event surfaces as a `<domain>.raw:<native>` passthrough (§3e), never dropped.
 *
 * @access public
 * @param {{ adapter: HookAdapter, harness: string, nativeEvent: string, payload: Record<string, unknown>, rawPayloadText?: string, sessionId?: string, db: HookDb }} args - Observation hook payload and persistence dependencies.
 * @returns {Promise<{ dedupe: string, rawRef: string, type: string }>} Promise resolving to the `observe` result.
 */
export async function observe({ adapter, harness, nativeEvent, payload, rawPayloadText, sessionId, db }) {
 const norm = adapter.toObservation(nativeEvent, payload)
 ?? { type: `session.raw:${harness}.${nativeEvent}`, payload: {}, ext: {} };
 const sid = norm.sessionId ?? sessionId;
 // A natural-id event keys on its id so the hook + transcript copies COLLAPSE . An id-LESS hook
 // event (e.g. a Cursor shell exec) gets a UNIQUE key — two distinct executions with identical
 // payloads are distinct events and must NOT destructively collapse/overwrite. Forward is
 // a one-shot process with no monotonic position, so content-hash+position-0 would wrongly merge them.
 const dedupe = norm.id ? forEvent(norm, { sessionId: sid }): `hook-uniq:${harness}:${nativeEvent}:${randomUUID()}`;

 // Redact-before-append: the raw native payload lives ONLY under a redacted `raw:` key. The key
 // embeds the (now-unique) dedupe so distinct id-less events never overwrite each other's raw.
 const rawRef = `raw:hook:${sid ?? 'na'}:${dedupe}`;
 await db.put(rawRef, rawPayloadText ?? payload);

  await db.append({
    dedupe, type: norm.type, payload: norm.payload, ext: norm.ext, // safe normalized ext only — no raw native payload
    ...(sid ? { sessionId: sid } : {}), source: 'hook', adapter: harness, rawRef
  });
  return { dedupe, rawRef, type: norm.type };
}
