/**
 * Claude-shaped hook translation, shared by the Claude Code AND Codex adapters (CONVENTIONS §3a —
 * shared pattern over copy-paste). Codex's native hook payloads are Claude-shaped (verified from real
 * captures: `hook_event_name`/`tool_name`/`tool_input`/`tool_response`/`tool_use_id`,
 * `stop_hook_active`), and its decision-RESPONSE schema is identical too — verified from the
 * captured Codex response behavior: PreToolUse →
 * `hookSpecificOutput.permissionDecision`; Stop/UserPromptSubmit → top-level `decision:'block'`+`reason`.
 * So both harnesses translate through the same pure functions; each declares its own `hookEvents` map.
 *
 * @module sumo/harness/hooks/claude-shaped
 */

/**
 * @typedef {{
 *   session_id?: string,
 *   tool_name?: string,
 *   tool_input?: unknown,
 *   tool_response?: unknown,
 *   tool_use_id?: string,
 *   prompt?: unknown,
 *   stop_hook_active?: boolean,
 *   last_assistant_message?: unknown,
 *   cwd?: string
 * }} ClaudeShapedPayload
 */

/**
 * Parse a Claude-shaped native hook payload into the normalized steer request.
 *
 * @access public
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {{ action: string, payload: Record<string, unknown>, ext: Record<string, unknown> }} Structured output from `toNativeRequestClaudeShaped`.
 */
export function toNativeRequestClaudeShaped(nativeEvent, payload = {}) {
  const native = /** @type {ClaudeShapedPayload} */ (payload);
  // Normalize the native session id into a stable `nativeSessionId` field so the steer-host can
  // correlate without knowing Claude's specific field name. Stored in ext alongside the raw native
  // payload so no existing ext consumers are affected.
  const ext = { native: payload, ...(native.session_id ? { nativeSessionId: native.session_id } : {}) };
  if (nativeEvent === 'PreToolUse') {
    return { action: 'tool', payload: { tool: { name: native.tool_name, input: native.tool_input }, toolUseId: native.tool_use_id }, ext };
  }
  if (nativeEvent === 'UserPromptSubmit') {
    return { action: 'prompt', payload: { prompt: native.prompt }, ext };
  }
  if (nativeEvent === 'Stop' || nativeEvent === 'SubagentStop') {
    return { action: 'finish', payload: { stopHookActive: native.stop_hook_active === true, lastMessage: native.last_assistant_message }, ext };
  }
  return { action: 'tool', payload: {}, ext };
}

/**
 * Normalize a Claude-shaped OBSERVATION payload into a `07` event (collapses with the transcript copy
 * on the shared natural id). `harnessId` stamps `session.started`.
 *
 * @access public
 * @param {string} harnessId - Harness id supplied to `toObservationClaudeShaped`.
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {import('sumo/transcript').NormalizedEventInput | null} Import('sumo/transcript') normalized event input null returned by `toObservationClaudeShaped`.
 */
export function toObservationClaudeShaped(harnessId, nativeEvent, payload = {}) {
  const native = /** @type {ClaudeShapedPayload} */ (payload);
  if (nativeEvent === 'PreToolUse' || nativeEvent === 'PostToolUse') {
    /** @type {{name: string, input?: unknown, output?: unknown}} */
    const tool = { name: native.tool_name ?? 'unknown' };
    if (native.tool_input !== undefined) tool.input = native.tool_input;
    if (native.tool_response !== undefined) tool.output = native.tool_response;
    return {
      type: 'session.tool', payload: { tool }, ext: {},
      ...(native.session_id ? { sessionId: native.session_id } : {}),
      ...(native.tool_use_id ? { id: native.tool_use_id } : {})
    };
  }
  if (nativeEvent === 'SessionStart') {
    return { type: 'session.started', payload: { harness: harnessId, ...(native.cwd ? { cwd: native.cwd } : {}) }, ext: {}, ...(native.session_id ? { id: native.session_id } : {}) };
  }
  if (nativeEvent === 'UserPromptSubmit') {
    return { type: 'session.message', payload: { role: 'user', text: typeof native.prompt === 'string' ? native.prompt : '' }, ext: {} };
  }
  return null;
}

/**
 * Translate `{ event?, deny?, inject? }` into the Claude-shaped native hook response (verified from
 * campsite for Claude and captured Codex adapter for Codex). The absence of a deny IS allow → write nothing.
 * `inject` maps to `additionalContext` (PreToolUse hookSpecificOutput, UserPromptSubmit top-level).
 * The Stop gate honors `stop_hook_active` so it never re-blocks an already-blocking stop.
 *
 * @access public
 * @param {{ event?: Record<string, unknown>, deny?: string, inject?: string }} decision - Decision object to translate.
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} List produced by `toNativeResponseClaudeShaped`.
 */
export function toNativeResponseClaudeShaped(decision, nativeEvent, payload = {}) {
  const denied = decision && typeof decision === 'object' && 'deny' in decision;
  const inject = decision?.inject;
  const none = { stdout: '', exitCode: 0, diagnostics: [] };
  if (nativeEvent === 'PreToolUse') {
    if (!denied && !inject) return none;
    /** @type {{hookEventName: string, permissionDecision?: string, permissionDecisionReason?: string, additionalContext?: string}} */
    const hookOutput = { hookEventName: 'PreToolUse' };
    if (denied) {
      hookOutput.permissionDecision = 'deny';
      hookOutput.permissionDecisionReason = decision.deny;
    }
    if (inject) hookOutput.additionalContext = inject;
    return { stdout: JSON.stringify({ hookSpecificOutput: hookOutput }), exitCode: 0, diagnostics: [] };
  }
  if (nativeEvent === 'Stop' || nativeEvent === 'SubagentStop') {
    if (!denied || payload.stop_hook_active === true) return none; // loop guard
    return { stdout: JSON.stringify({ decision: 'block', reason: decision.deny }), exitCode: 0, diagnostics: [] };
  }
  if (nativeEvent === 'UserPromptSubmit') {
    if (!denied && !inject) return none;
    /** @type {{decision?: string, reason?: string, additionalContext?: string}} */
    const out = {};
    if (denied) { out.decision = 'block'; out.reason = decision.deny; }
    if (inject) out.additionalContext = inject;
    return { stdout: JSON.stringify(out), exitCode: 0, diagnostics: [] };
  }
  return none;
}
