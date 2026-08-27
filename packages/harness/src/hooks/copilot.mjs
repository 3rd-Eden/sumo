/**
 * GitHub Copilot hook translation. Copilot supports both native camelCase hook names and VS Code
 * compatible PascalCase names, but its hook output schema is NOT Claude/Codex's nested
 * `hookSpecificOutput` shape. Keep this adapter-specific so Sumo does not fake parity across
 * harnesses.
 *
 * @module sumo/harness/hooks/copilot
 */

const EVENT_ALIASES = new Map([
  ['sessionStart', 'sessionStart'], ['SessionStart', 'sessionStart'], ['sessionEnd', 'sessionEnd'], ['SessionEnd', 'sessionEnd'], ['userPromptSubmitted', 'userPromptSubmitted'], ['UserPromptSubmit', 'userPromptSubmitted'], ['preToolUse', 'preToolUse'], ['PreToolUse', 'preToolUse'], ['postToolUse', 'postToolUse'], ['PostToolUse', 'postToolUse'], ['postToolUseFailure', 'postToolUseFailure'], ['PostToolUseFailure', 'postToolUseFailure'], ['permissionRequest', 'permissionRequest'], ['PermissionRequest', 'permissionRequest'], ['agentStop', 'agentStop'], ['Stop', 'agentStop'], ['subagentStart', 'subagentStart'], ['SubagentStart', 'subagentStart'], ['subagentStop', 'subagentStop'], ['SubagentStop', 'subagentStop'], ['errorOccurred', 'errorOccurred'], ['ErrorOccurred', 'errorOccurred'], ['preCompact', 'preCompact'], ['PreCompact', 'preCompact'], ['notification', 'notification'], ['Notification', 'notification']
]);

/**
 * Normalize a Copilot hook event name across native camelCase and VS Code-compatible PascalCase.
 *
 * @access private
 * @param {string} nativeEvent - Native hook event name.
 * @returns {string} String returned by `eventName`.
 */
function eventName(nativeEvent) {
  return EVENT_ALIASES.get(nativeEvent) ?? nativeEvent;
}

/**
 * Read either camelCase or VS Code-compatible snake_case fields from a Copilot hook payload.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @param {string} camel - Camel supplied to `field`.
 * @param {string} snake - Snake supplied to `field`.
 * @returns {unknown} Return value from `field`.
 */
function field(payload, camel, snake) {
  return payload?.[camel] ?? payload?.[snake];
}

/**
 * Extract the native Copilot session id from either supported payload format.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {string|undefined} String undefined returned by `nativeSessionId`.
 */
function nativeSessionId(payload) {
  return /** @type {string|undefined} */ (field(payload, 'sessionId', 'session_id'));
}

/**
 * Extract a Copilot tool name from either supported payload format.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {string|undefined} String undefined returned by `toolName`.
 */
function toolName(payload) {
  return /** @type {string|undefined} */ (field(payload, 'toolName', 'tool_name'));
}

/**
 * Extract Copilot tool arguments from either supported payload format.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {unknown} Return value from `toolArgs`.
 */
function toolArgs(payload) {
  return field(payload, 'toolArgs', 'tool_input');
}

/**
 * Extract Copilot permission-request tool input from either supported payload format.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {unknown} Return value from `permissionToolInput`.
 */
function permissionToolInput(payload) {
  return field(payload, 'toolInput', 'tool_input');
}

/**
 * Extract Copilot tool result from either supported payload format.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {unknown} Return value from `toolResult`.
 */
function toolResult(payload) {
  return field(payload, 'toolResult', 'tool_result');
}

/**
 * Parse a Copilot hook payload into the normalized steer request used by Sumo's daemon-hosted
 * decision path.
 *
 * @access public
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {{ action: string, payload: object, ext: object }} Structured output from `toNativeRequestCopilot`.
 */
export function toNativeRequestCopilot(nativeEvent, payload = {}) {
  const ext = { native: payload, ...(nativeSessionId(payload) ? { nativeSessionId: nativeSessionId(payload) } : {}) };
  const event = eventName(nativeEvent);
  if (event === 'preToolUse') {
    return { action: 'tool', payload: { tool: { name: toolName(payload), input: toolArgs(payload) } }, ext };
  }
  if (event === 'permissionRequest') {
    return { action: 'tool', payload: { tool: { name: toolName(payload), input: permissionToolInput(payload) } }, ext };
  }
  if (event === 'agentStop' || event === 'subagentStop') {
    return {
      action: 'finish', payload: {
        transcriptPath: field(payload, 'transcriptPath', 'transcript_path'), stopReason: field(payload, 'stopReason', 'stop_reason')
      }, ext
    };
  }
  return { action: 'tool', payload: {}, ext };
}

/**
 * Translate Sumo's `{event}|{deny}` result into Copilot's documented hook stdout shape.
 *
 * @access public
 * @param {{ event?: Record<string, unknown>, deny?: string, inject?: string }} decision - Decision object to translate.
 * @param {string} nativeEvent - Native hook event name.
 * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} List produced by `toNativeResponseCopilot`.
 */
export function toNativeResponseCopilot(decision, nativeEvent) {
  const denied = decision && typeof decision === 'object' && 'deny' in decision;
  const event = eventName(nativeEvent);
  if (!denied) return { stdout: '', exitCode: 0, diagnostics: [] };

  if (event === 'preToolUse') {
    return {
      stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: decision.deny }), exitCode: 0, diagnostics: []
    };
  }

  if (event === 'permissionRequest') {
    return {
      stdout: JSON.stringify({ behavior: 'deny', message: decision.deny }), exitCode: 0, diagnostics: []
    };
  }

  if (event === 'agentStop' || event === 'subagentStop') {
    return {
      stdout: JSON.stringify({ decision: 'block', reason: decision.deny }), exitCode: 0, diagnostics: []
    };
  }

  return { stdout: '', exitCode: 0, diagnostics: [] };
}

/**
 * Normalize a Copilot observation hook into a Sumo 07 event where the hook payload has a stable public
 * shape. Events with no natural id intentionally return no `id`; `sumo/hooks.observe()` then stores a
 * unique hook event rather than collapsing distinct tool invocations with identical payloads.
 *
 * @access public
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {import('sumo/transcript').NormalizedEventInput | null} Import('sumo/transcript') normalized event input null returned by `toObservationCopilot`.
 */
export function toObservationCopilot(nativeEvent, payload = {}) {
  const event = eventName(nativeEvent);
  const sessionId = nativeSessionId(payload);

  if (event === 'sessionStart') {
    return {
      type: 'session.started', payload: { harness: 'copilot', ...(field(payload, 'cwd', 'cwd') ? { cwd: field(payload, 'cwd', 'cwd') } : {}) }, ext: {},
      ...(sessionId ? { id: sessionId } : {})
    };
  }

  if (event === 'sessionEnd') {
    return {
      type: 'session.ended', payload: { reason: field(payload, 'reason', 'reason') }, ext: {},
      ...(sessionId ? { sessionId } : {})
    };
  }

  if (event === 'userPromptSubmitted') {
    return { type: 'session.message', payload: { role: 'user', text: field(payload, 'prompt', 'prompt') }, ext: {}, ...(sessionId ? { sessionId } : {}) };
  }

  if (event === 'preToolUse' || event === 'postToolUse' || event === 'postToolUseFailure') {
    /** @type {{name: string, input?: unknown, output?: unknown, error?: unknown}} */
    const tool = { name: toolName(payload) ?? 'unknown' };
    if (toolArgs(payload) !== undefined) tool.input = toolArgs(payload);
    if (toolResult(payload) !== undefined) tool.output = toolResult(payload);
    if (field(payload, 'error', 'error') !== undefined) tool.error = field(payload, 'error', 'error');
    return { type: 'session.tool', payload: { tool }, ext: {}, ...(sessionId ? { sessionId } : {}) };
  }

  return null;
}
