/**
 * Integration tests for real Sumo machinery. These exercise:
 *
 *  1. The tmux interactive control path against REAL tmux + a real process: `key()` → `capture()`.
 *  2. The Codex `server` transport against the REAL `codex app-server`: the JSON-RPC
 *     `initialize`→`thread/start` handshake + id-correlated `request` (no model call).
 *  3. Transport presence — the basis the base presence-probes to gate `key`/`capture`/`respondApproval`.
 *
 * tmux/Codex tests need a real external dependency. When it is absent they skip with
 * a clear "requires <binary>" message — never a mock fallback (§3f/§5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { Codex } from '../src/index.mjs';
import { Pipe, CodexAppServer, CopilotServer } from '../src/transport/index.mjs';
import { frameApprovalResponse } from '../src/transport/CodexAppServer.mjs';
import { toCopilotPermissionDecision } from '../src/transport/CopilotServer.mjs';
import { isResult } from '../src/base/schema.mjs';
import { tmuxAvailable } from '../src/transport/tmux.mjs';
import { assertAvailable } from './_live.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;

const HAS_TMUX = await tmuxAvailable();

// Required-dependency guard: a missing external CLI skips clearly, it is never mocked.
/** Implement requireDep. */ function requireDep(present, name, t) {
  if (!present) {
    t.skip(`requires the \`${name}\` dependency; it is not available in this environment — install it or run elsewhere (this test never mocks it).`);
    return false;
  }
  return true;
}

// ── tmux interactive control against REAL tmux ───────────────────────────────────────────────────

test('integration: tmux interactive Pipe sends keys and captures the pane', /** Verify integration: tmux interactive Pipe sends keys and captures the pane. */ async (t) => {
  if (!requireDep(HAS_TMUX, 'tmux', t)) return;
  // `cat` echoes whatever is typed into the pane — a deterministic, model-free interactive target.
  const session = `sumo-it-${process.pid}`;
  const pipe = new Pipe({ command: 'cat', args: [], mode: 'interactive', session });
  await pipe.open();
  try {
    assert.deepEqual(pipe.health, { alive: true });
    pipe.endInput(); // no stdin pipe in pane mode; this is an honest no-op.
    // Interactive mode is control-only: frames() yields nothing (observation is via the transcript/09).
    const frames = [];
    for await (const f of pipe.frames()) frames.push(f);
    assert.equal(frames.length, 0, 'pane mode produces no stream frames by design');

    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 200));
    await pipe.send('typed-via-send'); // literal text + Enter into the pane
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 200));
    const snap = await pipe.capture();
    assert.match(snap, /typed-via-send/, 'capture-pane reflects what was sent');
    assert.equal(typeof snap, 'string');
    assert.deepEqual(await pipe.interrupt(), { ok: true });
  } finally {
    await pipe.close();
  }
});

test('integration: a tmux-pane (interactive) Claude session reports key+transcript-file caps', /** Verify integration: a tmux-pane (interactive) Claude session reports key+transcript-file caps. */ async (t) => {
  if (!requireDep(HAS_TMUX, 'tmux', t)) return;
  // CapabilitySchema descriptor for an interactive launch — now backed by a transport whose key()/capture()
  // are proven (above), so the declared can.key/can.capture are capture-verified, not just asserted.
  const { Claude } = await import('../src/index.mjs');
  // This test is gated on tmux being present (requireDep above), so the descriptor is computed with
  // tmux available — key/capture are genuinely backed ().
  const caps = new Claude().capabilitiesFor('interactive', { tmuxAvailable: true });
  assert.equal(caps.canSendKey, true);
  assert.equal(caps.canCapture, true);
  assert.equal(caps.observationSource, 'transcript-file');
});

// ── Codex server transport against the REAL app-server (handshake only, no model call) ───────────

test('integration: CodexAppServer completes the real JSON-RPC handshake', /** Verify integration: CodexAppServer completes the real JSON-RPC handshake. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-it-codex-'));
  const transport = new CodexAppServer({
    command: cfg.bin ?? 'codex',
    cwd,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    optOutMethods: ['thread/tokenUsage/updated'],
    model: 'codex-mini-latest',
    reasoningEffort: 'minimal'
  });
  try {
    await transport.open();
    assert.ok(transport.threadId, 'initialize→thread/start established a thread id');
    assert.equal(transport.kind, 'server');
    assert.equal(transport.health.alive, true);
    // A second correlated request resolves to a Result — proves id-correlation works on the real wire.
    const r = await transport.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request' });
    assert.ok(isResult(r) && r.ok === true, 'a correlated request resolves');
    const bad = await transport.request('sumo/no-such-method', {});
    assert.ok(isResult(bad) && bad.ok === false, 'JSON-RPC errors resolve as failed Results');
    const idleCancel = await transport.interrupt();
    assert.deepEqual(idleCancel, { ok: true, value: { interrupted: false } });
    const missingApprovalId = await transport.respondApproval({ decision: 'accept' });
    assert.equal(missingApprovalId.ok, false);
    assert.equal(missingApprovalId.code, 'SUMO_INTERNAL');

    const resumed = new CodexAppServer({
      command: cfg.bin ?? 'codex',
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      resume: transport.threadId
    });
    try {
      await assert.rejects(
        /** Run the callback. */ () => resumed.open(),
        /thread\/resume failed/,
        'the real app-server refuses resume before a rollout exists; Sumo surfaces that honestly'
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await transport.close();
    const dead = await transport.request('thread/start', { cwd });
    assert.equal(dead.ok, false);
    assert.equal(dead.code, 'SUMO_SESSION_DEAD');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Codex approval protocol — against the CAPTURED real request frame + verified reply shape ─────

test('integration: a captured codex approval request surfaces with a recoverable requestId', /** Verify integration: a captured codex approval request surfaces with a recoverable requestId. */ () => {
  const frame = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures/codex/control/approval-request.jsonl'), 'utf8').trim());
  const events = [...new Codex().read(frame)];
  assert.equal(events.length, 1, 'the approval request surfaces as exactly one event');
  const [e] = events;
  assert.equal(e.type, 'session.approval-requested');
  assert.equal(e.payload.requestId, 0);
  assert.equal(e.payload.command, frame.params.command);
  assert.ok(e.payload.availableDecisions.includes('accept'));
  // Lossless: the JSON-RPC id + availableDecisions an orchestrator needs to respond are preserved.
  assert.equal(e.ext.native.id, 0, 'JSON-RPC request id preserved for respondApproval');
  assert.ok(Array.isArray(e.ext.native.params.availableDecisions), 'available decisions preserved');
  assert.ok(e.ext.native.params.availableDecisions.includes('accept'));
});

test('integration: respondApproval framing matches the verified codex accept shape', /** Verify integration: respondApproval framing matches the verified codex accept shape. */ () => {
  // The exact bytes proven (against the real app-server) to execute the approved command.
  assert.equal(
    frameApprovalResponse({ requestId: 0, decision: 'accept' }),
    '{"jsonrpc":"2.0","id":0,"result":{"decision":"accept"}}\n'
  );
});

// ── Transport presence — the basis for capability gating (no spawn) ──────────────────────────────

test('integration: transport effector presence matches each kind', /** Verify integration: transport effector presence matches each kind. */ () => {
  const pipe = new Pipe({ command: NODE, args: [] });
  assert.equal(typeof pipe.send, 'function', 'pipe sends');
  assert.equal(typeof pipe.key, 'function', 'pipe keys (tmux)');
  assert.equal(typeof pipe.capture, 'function', 'pipe captures');
  assert.equal(pipe.request, undefined, 'pipe has no correlated request');
  assert.equal(pipe.respondApproval, undefined, 'pipe has no approvals');

  const codex = new CodexAppServer();
  assert.equal(typeof codex.request, 'function', 'server requests');
  assert.equal(typeof codex.respondApproval, 'function', 'server approves');
  assert.equal(codex.key, undefined, 'server has no terminal key injection');
  assert.equal(codex.capture, undefined, 'server has no screen to capture → capture() unsupported');

  const copilot = new CopilotServer();
  assert.equal(typeof copilot.request, 'function', 'copilot server requests');
  assert.equal(typeof copilot.respondApproval, 'function', 'copilot approval uses the SDK pending-permission RPC');
  assert.equal(copilot.key, undefined, 'copilot server has no terminal key injection');
  assert.equal(copilot.capture, undefined, 'copilot server has no screen to capture');
});

test('integration: CopilotServer unopened control paths degrade as Results', /** Verify integration: CopilotServer unopened control paths degrade as Results. */ async () => {
  const transport = new CopilotServer();
  transport.cwd = process.cwd();
  transport.model = 'claude-sonnet-4.6';
  transport.reasoningEffort = 'low';
  transport.resume = 'native-session';

  assert.equal(transport.kind, 'server');
  assert.deepEqual(transport.health, { alive: false, heartbeat: 0 });

  const send = await transport.request('session/send', { prompt: 'hello' });
  assert.equal(send.ok, false);
  assert.equal(send.code, 'SUMO_SESSION_DEAD');

  const cancel = await transport.interrupt();
  assert.equal(cancel.ok, false);
  assert.equal(cancel.code, 'SUMO_SESSION_DEAD');

  await transport.close();
  transport.kill();
  assert.deepEqual(transport.evidence, { stderr: '', snapshot: '', spawnError: null, exitCode: null, signal: null });
});

test('integration: Copilot permission decisions map to the SDK pending-permission result shape', /** Verify integration: Copilot permission decisions map to the SDK pending-permission result shape. */ () => {
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'accept' }), { kind: 'approve-once' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'approve' }), { kind: 'approve-once' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'allow' }), { kind: 'approve-once' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'acceptForSession' }), { kind: 'approve-for-session' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'approveForSession' }), { kind: 'approve-for-session' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'cancel', reason: 'stopped' }), { kind: 'cancelled', reason: 'stopped' });
  assert.deepEqual(toCopilotPermissionDecision({ decision: 'deny', reason: 'unsafe' }), { kind: 'reject', feedback: 'unsafe' });
  assert.deepEqual(toCopilotPermissionDecision({}), { kind: 'reject' });
});
