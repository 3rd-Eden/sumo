/**
 * Hook-surface conformance across adapters (spec 12, §4). Asserts classification + observation
 * normalization against REAL captured payloads where committed, and the per-harness DECISION response
 * against the primary artifact that verifies each: campsite-rule (Claude), captured Codex adapter (Codex),
 * Cursor's official hook docs (Cursor), and captured Copilot file-hook payloads plus SDK docs
 * (Copilot). Parity, not matrix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from '../src/index.mjs';
import { classify } from 'sumo/hooks';
import { EventSchema } from '../../transcript/src/base/schema.mjs';

const HOOK_FIX = path.join(fileURLToPath(new URL('./fixtures/hook', import.meta.url)));
/** Implement load. */ function load(rel) { return JSON.parse(fs.readFileSync(path.join(HOOK_FIX, rel), 'utf8')); }

test('all hooks-capable adapters declare can.hooks and map a decision hook', /** Verify all hooks-capable adapters declare can.hooks and map a decision hook. */ () => {
  for (const id of ['claude-code', 'codex', 'copilot', 'cursor']) {
    const a = new adapters[id]();
    assert.equal(a.can.hooks, true, `${id} declares can.hooks`);
    const hasDecide = Object.values(a.hookEvents).some(/** Test whether an item matches. */ (h) => h.kind === 'decide');
    assert.ok(hasDecide, `${id} maps at least one decision hook`);
  }

  const copilot = new adapters.copilot();
  const preToolUse = load('copilot/preToolUse.json');
  assert.deepEqual(classify(copilot, 'preToolUse'), { kind: 'decide', action: 'tool' });
  const req = copilot.toNativeRequest('preToolUse', preToolUse);
  assert.equal(req.action, 'tool');
  assert.deepEqual(req.payload, { tool: { name: 'bash', input: preToolUse.toolArgs } });
  assert.equal(req.ext.nativeSessionId, 'copilot-native-session');
  assert.deepEqual(JSON.parse(copilot.toNativeResponse({ deny: 'blocked' }, 'preToolUse', preToolUse).stdout), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'blocked'
  });
  assert.equal(copilot.toNativeResponse({ event: {} }, 'preToolUse', preToolUse).stdout, '');

  const postToolUse = load('copilot/postToolUse.json');
  const observed = copilot.toObservation('postToolUse', postToolUse);
  assert.equal(observed.type, 'session.tool');
  assert.equal(observed.sessionId, 'copilot-native-session');
  assert.equal(observed.payload.tool.name, 'bash');
  assert.deepEqual(observed.payload.tool.input, postToolUse.toolArgs);
  assert.deepEqual(observed.payload.tool.output, postToolUse.toolResult);
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(observed));

  const permissionRequest = load('copilot/permissionRequest.json');
  assert.deepEqual(classify(copilot, 'permissionRequest'), { kind: 'decide', action: 'tool' });
  const permissionReq = copilot.toNativeRequest('permissionRequest', permissionRequest);
  assert.equal(permissionReq.action, 'tool');
  assert.deepEqual(permissionReq.payload, { tool: { name: 'bash', input: permissionRequest.toolInput } });
  assert.equal(permissionReq.ext.nativeSessionId, 'copilot-native-session');
  assert.deepEqual(JSON.parse(copilot.toNativeResponse({ deny: 'blocked' }, 'permissionRequest', permissionRequest).stdout), {
    behavior: 'deny',
    message: 'blocked'
  });

  const stop = load('copilot/agentStop.json');
  const stopReq = copilot.toNativeRequest('agentStop', stop);
  assert.equal(stopReq.action, 'finish');
  assert.deepEqual(stopReq.payload, { transcriptPath: stop.transcriptPath, stopReason: 'end_turn' });
  assert.equal(stopReq.ext.nativeSessionId, 'copilot-native-session');
  assert.deepEqual(JSON.parse(copilot.toNativeResponse({ deny: 'continue' }, 'agentStop', stop).stdout), {
    decision: 'block',
    reason: 'continue'
  });

  const started = copilot.toObservation('sessionStart', load('copilot/sessionStart.json'));
  assert.equal(started.type, 'session.started');
  assert.equal(started.id, 'copilot-native-session');
  assert.equal(started.payload.harness, 'copilot');
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(started));

  assert.equal(copilot.toObservation('sessionEnd', { sessionId: 'copilot-native-session', reason: 'complete' }).type, 'session.ended');
  assert.equal(copilot.toObservation('userPromptSubmitted', load('copilot/userPromptSubmitted.json')).payload.text, 'Use the bash tool to run exactly: printf copilot-hook-fixture > /tmp/sumo-copilot-hooks/tool.txt');
  assert.equal(copilot.toObservation('postToolUseFailure', { sessionId: 'copilot-native-session', toolName: 'bash', error: 'boom' }).payload.tool.error, 'boom');
  assert.equal(copilot.toNativeRequest('notification', { sessionId: 'copilot-native-session' }).action, 'tool');
  assert.equal(copilot.toNativeResponse({ deny: 'ignored' }, 'notification').stdout, '');
  assert.equal(copilot.toObservation('notification', { sessionId: 'copilot-native-session' }), null);
});

test('claude-code: PreToolUse deny → verified permissionDecision schema (campsite-rule)', /** Verify claude-code: PreToolUse deny → verified permissionDecision schema (campsite-rule). */ () => {
  const a = new adapters['claude-code']();
  assert.deepEqual(classify(a, 'PreToolUse'), { kind: 'decide', action: 'tool' });
  const res = a.toNativeResponse({ deny: 'no' }, 'PreToolUse', {});
  assert.deepEqual(JSON.parse(res.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
});

test('claude-code: Stop payload maps to finish and inject maps to native additionalContext', /** Verify claude-code: Stop payload maps to finish and inject maps to native additionalContext. */ () => {
  const a = new adapters['claude-code']();
  const stop = load('claude-code/Stop.json');
  const req = a.toNativeRequest('Stop', stop);
  assert.equal(req.action, 'finish');
  assert.deepEqual(req.payload, {
    stopHookActive: false,
    lastMessage: stop.last_assistant_message
  });
  assert.equal(req.ext.nativeSessionId, stop.session_id);

  const preToolInject = JSON.parse(a.toNativeResponse({ inject: 'use safer command' }, 'PreToolUse', {}).stdout);
  assert.deepEqual(preToolInject, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'use safer command' }
  });

  const promptInject = JSON.parse(a.toNativeResponse({ inject: 'include ticket id' }, 'UserPromptSubmit', {}).stdout);
  assert.deepEqual(promptInject, { additionalContext: 'include ticket id' });
  assert.deepEqual(JSON.parse(a.toNativeResponse({ deny: 'halt', inject: 'state summary' }, 'UserPromptSubmit', {}).stdout), {
    decision: 'block',
    reason: 'halt',
    additionalContext: 'state summary'
  });
  assert.equal(a.toNativeResponse({ deny: 'ignored' }, 'SomeFutureHook', {}).stdout, '');
  assert.equal(a.toNativeResponse({ event: {} }, 'UserPromptSubmit', {}).stdout, '');
  assert.equal(a.toNativeRequest('SomeFutureHook', { session_id: stop.session_id }).action, 'tool');
  assert.equal(a.toNativeRequest('SubagentStop', stop).action, 'finish');
  assert.deepEqual(a.toNativeRequest('PreToolUse', {}).payload, { tool: { name: undefined, input: undefined }, toolUseId: undefined });
});

test('codex: PreToolUse deny → permissionDecision; Stop deny → decision:block (verified: captured Codex adapter)', /** Verify codex: PreToolUse deny → permissionDecision; Stop deny → decision:block (verified: captured Codex adapter). */ () => {
  const a = new adapters.codex();
  assert.deepEqual(classify(a, 'PreToolUse'), { kind: 'decide', action: 'tool' });
  // PreToolUse deny — byte-for-byte the captured native response schema.
  assert.deepEqual(
    JSON.parse(a.toNativeResponse({ deny: 'blocked' }, 'PreToolUse', {}).stdout),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }
  );
  // Stop deny — decision:block + reason (captured Codex adapter Stop formatting), honoring stop_hook_active.
  assert.deepEqual(JSON.parse(a.toNativeResponse({ deny: 'resolve first' }, 'Stop', { stop_hook_active: false }).stdout), { decision: 'block', reason: 'resolve first' });
  assert.equal(a.toNativeResponse({ deny: 'x' }, 'Stop', { stop_hook_active: true }).stdout, '', 'loop guard');
});

test('codex: UserPromptSubmit uses the real prompt payload and blocks in native shape', /** Verify codex: UserPromptSubmit uses the real prompt payload and blocks in native shape. */ () => {
  const a = new adapters.codex();
  const payload = load('codex/UserPromptSubmit.json');
  const req = a.toNativeRequest('UserPromptSubmit', payload);
  assert.equal(req.action, 'prompt');
  assert.equal(req.payload.prompt, payload.prompt);
  assert.equal(req.ext.nativeSessionId, payload.session_id);
  assert.deepEqual(JSON.parse(a.toNativeResponse({ deny: 'blocked prompt' }, 'UserPromptSubmit', payload).stdout), {
    decision: 'block',
    reason: 'blocked prompt'
  });

  const observed = a.toObservation('UserPromptSubmit', payload);
  assert.equal(observed.type, 'session.message');
  assert.equal(observed.payload.role, 'user');
  assert.equal(observed.payload.text, payload.prompt);
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(observed));
});

test('codex: SessionStart observation normalizes the REAL native startup payload', /** Verify codex: SessionStart observation normalizes the REAL native startup payload. */ () => {
  const a = new adapters.codex();
  const ev = a.toObservation('SessionStart', load('codex/SessionStart.json'));
  assert.equal(ev.type, 'session.started');
  assert.equal(ev.id, '019f15d8-d288-7db3-834b-950efb8344ce');
  assert.equal(ev.payload.harness, 'codex');
  assert.equal(ev.payload.cwd, '/private/tmp/sumo-codex-hook-probe');
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(ev));
});

test('codex: observation normalizes the REAL Claude-shaped PostToolUse payload', /** Verify codex: observation normalizes the REAL Claude-shaped PostToolUse payload. */ () => {
  const a = new adapters.codex();
  const ev = a.toObservation('PostToolUse', load('codex/PostToolUse.json'));
  assert.equal(ev.type, 'session.tool');
  assert.equal(ev.id, 'call_DvWyIzigcvRcQKZ3ClqLtMC3');
  assert.equal(ev.payload.tool.name, 'Bash');
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(ev));
});

test('claude-shaped observations preserve real PreToolUse input and degrade unknown hooks', /** Verify claude-shaped observations preserve real PreToolUse input and degrade unknown hooks. */ () => {
  const a = new adapters['claude-code']();
  const payload = load('claude-code/PreToolUse.json');
  const ev = a.toObservation('PreToolUse', payload);
  assert.equal(ev.type, 'session.tool');
  assert.equal(ev.id, payload.tool_use_id);
  assert.equal(ev.payload.tool.name, payload.tool_name);
  assert.deepEqual(ev.payload.tool.input, payload.tool_input);
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(ev));
  const noId = a.toObservation('PreToolUse', { tool_name: 'Read' });
  assert.equal(noId.id, undefined);
  assert.equal(noId.payload.tool.name, 'Read');
  const started = a.toObservation('SessionStart', {});
  assert.deepEqual(started.payload, { harness: 'claude-code' });
  assert.equal(started.id, undefined);
  assert.equal(a.toObservation('SomeFutureHook', payload), null);
});

test('cursor: beforeShellExecution deny → {permission:"deny", agent_message} (verified: Cursor docs)', /** Verify cursor: beforeShellExecution deny → {permission:"deny", agent_message} (verified: Cursor docs). */ () => {
  const a = new adapters.cursor();
  assert.deepEqual(classify(a, 'beforeShellExecution'), { kind: 'decide', action: 'tool' });
  const res = a.toNativeResponse({ deny: 'no shell' }, 'beforeShellExecution', {});
  assert.deepEqual(JSON.parse(res.stdout), { permission: 'deny', agent_message: 'no shell' });
  // a pass writes nothing (absence of deny is allow)
  assert.equal(a.toNativeResponse({ event: {} }, 'beforeShellExecution', {}).stdout, '');
});

test('cursor: parses the REAL afterShellExecution payload; headless-absent events stay unmapped', /** Verify cursor: parses the REAL afterShellExecution payload; headless-absent events stay unmapped. */ () => {
  const a = new adapters.cursor();
  const ev = a.toObservation('afterShellExecution', load('cursor/afterShellExecution.json'));
  assert.equal(ev.payload.tool.input.command, 'pwd');
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(ev));
  for (const absent of ['stop', 'afterAgentResponse', 'beforeSubmitPrompt']) {
    assert.equal(a.hookEvents[absent], undefined, `${absent} not emitted headless → unmapped`);
    assert.deepEqual(classify(a, absent), { kind: 'observe' }, 'unmapped → observation, never fabricated');
  }
});

test('every adapter: a pass ({event}) yields empty stdout (absence of deny IS allow)', /** Verify every adapter: a pass ({event}) yields empty stdout (absence of deny IS allow). */ () => {
  for (const [id, ev] of [['claude-code', 'PreToolUse'], ['codex', 'PreToolUse'], ['cursor', 'beforeShellExecution']]) {
    const res = new adapters[id]().toNativeResponse({ event: {} }, ev, {});
    assert.equal(res.stdout, '', `${id} ${ev} pass writes nothing`);
  }
});
