/**
 * Live smoke against the ACTUAL harnesses — the control-path capture + drift detector for the harness
 * layer (mirrors `sumo/transcript`'s `live.test.mjs`). The conformance suite proves read()/mapping/
 * dedupe/degradation against committed fixtures; THIS proves the parts a fixture can't: real spawn,
 * the transport handshake, the first-prompt write (Claude stdin stream-json, Cursor positional, Codex
 * `turn/start`), and that `run()` → `Session.join()` yields normalized events.
 *
 * These spawn the installed CLIs and make real model calls (cost + network + nondeterminism). When a
 * required binary is absent they skip with a clear reason — never a mock fallback (§3f/§5). Point
 * `SUMO_<HARNESS>_BIN` at the real binary when PATH holds a wrapper shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { Claude, Cursor, Codex, Copilot } from '../src/index.mjs';
import { CopilotServer } from '../src/transport/CopilotServer.mjs';
import { installCopilotHooks } from '../src/install/copilot.mjs';
import { assertClaudeBin, assertAvailable, deleteCopilotSession, waitForPath } from './_live.mjs';

const PROMPT = 'Reply with exactly: HELLO';
const TIMEOUT_MS = 120_000;
const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);
const liveUnavailableByHarness = new Map();

/** Implement liveUnavailableCode. */ function liveUnavailableCode(events) {
  return events.find(/** Find a matching item. */ (e) => LIVE_UNAVAILABLE.has(e.ext?.classification?.code ?? e.payload?.sumoCode))?.ext?.classification?.code
    ?? events.find(/** Find a matching item. */ (e) => LIVE_UNAVAILABLE.has(e.payload?.sumoCode))?.payload?.sumoCode
    ?? '';
}

/** Run a harness to first assistant message (or timeout), then end it. Returns the collected events. */
async function driveToAssistant(harness) {
  const session = await harness.run(PROMPT, { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-harness-live-')) });
  const events = [];
  const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
  try {
    for await (const e of session.join()) {
      events.push(e);
      if (e.type === 'session.message' && e.payload.role === 'assistant') break;
      if (liveUnavailableCode(events)) break;
      if (e.type === 'session.ended' || e.type === 'session.dead') break;
    }
  } finally {
    clearTimeout(deadline);
    await session.end().catch(/** Handle the expected rejection. */ () => {});
  }
  return events;
}

/** Implement assertAssistant. */ function assertAssistant(events, label) {
  assert.ok(events.length > 0, `${label}: no events (spawn/handshake/read path failed)`);
  assert.ok(
    events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'),
    `${label}: no assistant session.message — control path produced no normalized assistant turn`
  );
  for (const e of events) assert.ok(typeof e.dedupe === 'string' && e.dedupe.length > 0, `${label}: event missing dedupe`);
}

/** Implement skipIfLiveUnavailable. */ function skipIfLiveUnavailable(t, events, harnessId, label) {
  const code = liveUnavailableCode(events);
  if (!code) return false;
  liveUnavailableByHarness.set(harnessId, code);
  t.skip(`${label} live prerequisite unavailable: ${code}`);
  return true;
}

test('LIVE claude-code: run() → assistant message via stdin stream-json', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE claude-code: run() → assistant message via stdin stream-json. */ async (t) => {
  const bin = await assertClaudeBin(t);
  if (!bin) return;
  assertAssistant(await driveToAssistant(new Claude({ config: { bin } })), 'claude-code');
});

test('LIVE cursor: run() → assistant message via positional prompt', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE cursor: run() → assistant message via positional prompt. */ async (t) => {
  const cfg = await assertAvailable(Cursor, process.env.SUMO_CURSOR_BIN ? { bin: process.env.SUMO_CURSOR_BIN } : {}, t);
  if (!cfg) return;
  assertAssistant(await driveToAssistant(new Cursor({ config: cfg })), 'cursor');
});

test('LIVE codex: run() → assistant message via app-server turn/start', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE codex: run() → assistant message via app-server turn/start. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const events = await driveToAssistant(new Codex({ config: cfg }));
  if (skipIfLiveUnavailable(t, events, 'codex', 'codex')) return;
  assertAssistant(events, 'codex');
});

test('LIVE copilot: run() → assistant message via SDK-backed server session', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: run() → assistant message via SDK-backed server session. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  const events = await driveToAssistant(new Copilot({ config: cfg }));
  if (skipIfLiveUnavailable(t, events, 'copilot', 'copilot')) return;
  assertAssistant(events, 'copilot');
});

test('LIVE copilot: installed repository file hooks execute through the SDK harness path', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: installed repository file hooks execute through the SDK harness path. */ async (t) => {
  const unavailableCode = liveUnavailableByHarness.get('copilot');
  if (unavailableCode) {
    t.skip(`copilot hook live prerequisite unavailable: ${unavailableCode}`);
    return;
  }
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copilot-file-hooks-'));
  try {
    spawnSync('git', ['init'], { cwd, stdio: 'ignore' });
    const captureFile = path.join(cwd, 'hook-captures.jsonl');
    const hookScript = path.join(cwd, 'capture-hook.mjs');
    fs.writeFileSync(hookScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const chunks = [];',
      'for await (const chunk of process.stdin) chunks.push(chunk);',
      `fs.appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      '  argv: process.argv.slice(2),',
      "  stdin: Buffer.concat(chunks).toString('utf8')",
      "}) + '\\n');"
    ].join('\n'));

    const installed = installCopilotHooks({
      projectDir: cwd,
      hooks: [
        { event: 'sessionStart' },
        { event: 'userPromptSubmitted' },
        { event: 'agentStop' }
      ],
      bin: `node ${hookScript}`
    });
    assert.equal(installed.ok, true);

    const session = await new Copilot({ config: { ...cfg, cwd } }).run('Reply exactly: hook live smoke', { cwd });
    const events = [];
    const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
    try {
      for await (const e of session.join()) {
        events.push(e);
        if (liveUnavailableCode(events)) break;
        if (fs.existsSync(captureFile) && fs.readFileSync(captureFile, 'utf8').trim().split('\n').length >= 3) break;
        if (e.type === 'session.ended' || e.type === 'session.dead') break;
      }
    } finally {
      clearTimeout(deadline);
      await session.end().catch(/** Handle the expected rejection. */ () => {});
    }

    if (skipIfLiveUnavailable(t, events, 'copilot', 'copilot hooks')) return;
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:hook.start'), 'Copilot emitted hook.start events');
    const captures = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map(/** Map one item. */ (line) => JSON.parse(line));
    assert.deepEqual(captures.map(/** Map one item. */ (entry) => entry.argv[0]).sort(), ['agentStop', 'sessionStart', 'userPromptSubmitted']);
    const nativeSessionIds = new Set();
    for (const entry of captures) {
      const payload = JSON.parse(entry.stdin);
      assert.equal(typeof payload.sessionId, 'string');
      nativeSessionIds.add(payload.sessionId);
      assert.equal(payload.cwd, cwd);
    }
    assert.equal(nativeSessionIds.size, 1, 'all file hooks ran for the same native Copilot session');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('LIVE copilot: full permission round-trip — request surfaces, respondApproval(accept) executes', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: full permission round-trip — request surfaces, respondApproval(accept) executes. */ async (t) => {
  const unavailableCode = liveUnavailableByHarness.get('copilot');
  if (unavailableCode) {
    t.skip(`copilot approval live prerequisite unavailable: ${unavailableCode}`);
    return;
  }
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copilot-approval-'));
  const outFile = path.join(cwd, 'approval.txt');
  const session = await new Copilot({ config: { ...cfg, cwd } }).run(
    `Use the bash tool to run exactly: printf copilot-approved > ${outFile}`
  );

  let responded = false;
  const events = [];
  const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
  try {
    for await (const e of session.join()) {
      events.push(e);
      if (liveUnavailableCode(events)) break;
      if (!responded && e.type === 'session.approval-requested') {
        const r = await session.respondApproval({ requestId: e.payload.requestId, decision: 'accept' });
        assert.ok(r.ok, 'copilot respondApproval accepted');
        responded = true;
      }
      if (responded && await waitForPath(outFile, 1000)) break;
      if (e.type === 'session.ended' || e.type === 'session.dead') break;
    }
  } finally {
    clearTimeout(deadline);
    await session.end().catch(/** Handle the expected rejection. */ () => {});
  }

  if (skipIfLiveUnavailable(t, events, 'copilot', 'copilot approval')) return;
  assert.ok(responded, 'copilot surfaced an approval request');
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'copilot-approved');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('LIVE copilot transport: direct SDK open/create then resume keeps control paths usable', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot transport: direct SDK open/create then resume keeps control paths usable. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copilot-transport-live-'));
  let nativeSessionId = '';
  /** @type {CopilotServer|null} */
  let first = null;
  /** @type {CopilotServer|null} */
  let resumed = null;
  let onEventCalls = 0;

  try {
    first = new CopilotServer({
      command: cfg.bin ?? 'copilot',
      cwd,
      model: cfg.model,
      reasoningEffort: 'low',
      /** Implement onEvent. */ onEvent() {
        onEventCalls++;
        throw new Error('ignore user callback failure');
      }
    });

    await first.open();
    nativeSessionId = first.sessionId;
    assert.ok(nativeSessionId, 'open() returns a native session id');

    const sent = await first.request('session/send', { prompt: 'Reply with exactly: transport smoke' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.ok(first.health.heartbeat > 0, 'SDK events increment the heartbeat');
    assert.ok(onEventCalls > 0, 'user event callback is invoked');

    const unsupported = await first.request('session/not-supported', {});
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'SUMO_NOT_IMPLEMENTED');

    const missingApprovalId = await first.respondApproval({ decision: 'accept' });
    assert.equal(missingApprovalId.ok, false);
    assert.equal(missingApprovalId.code, 'SUMO_INVALID_ARGUMENT');

    const interrupted = await first.interrupt();
    assert.equal(interrupted.ok, true);
    assert.equal(typeof interrupted.value.interrupted, 'boolean');

    resumed = new CopilotServer({ command: cfg.bin ?? 'copilot' });
    resumed.cwd = cwd;
    resumed.model = cfg.model ?? 'gpt-5';
    resumed.reasoningEffort = 'low';
    resumed.resume = nativeSessionId;

    await resumed.open();
    assert.equal(resumed.sessionId, nativeSessionId);

    const resumedSend = await resumed.request('session/send', { prompt: 'Reply with exactly: resumed transport smoke' });
    assert.equal(resumedSend.ok, true, JSON.stringify(resumedSend));
  } finally {
    await resumed?.close().catch(/** Handle the expected rejection. */ () => {});
    await first?.close().catch(/** Handle the expected rejection. */ () => {});
    if (nativeSessionId) await deleteCopilotSession(nativeSessionId, { bin: cfg.bin, cwd }).catch(/** Handle the expected rejection. */ () => {});
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('LIVE codex: full approval round-trip — request surfaces, respondApproval(accept) executes', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE codex: full approval round-trip — request surfaces, respondApproval(accept) executes. */ async (t) => {
  const unavailableCode = liveUnavailableByHarness.get('codex');
  if (unavailableCode) {
    t.skip(`codex approval live prerequisite unavailable: ${unavailableCode}`);
    return;
  }
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const bin = cfg.bin ?? 'codex';
  // A write under the read-only sandbox forces a server-initiated approval; accepting it must let the
  // command run. Proves the whole loop end to end: read → surface approval → respondApproval → effect.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-harness-approval-'));
  const outFile = path.join(cwd, 'out.txt');
  const runCfg = { bin, cwd, sandbox: 'read-only', approvalPolicy: 'on-request' };
  const session = await new Codex({ config: runCfg }).run(
    `Write the text hi into ${outFile} using the shell tool. The sandbox is read-only, so request approval.`
  );

  let responded = false;
  const events = [];
  const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
  try {
    for await (const e of session.join()) {
      events.push(e);
      if (liveUnavailableCode(events)) break;
      if (!responded && e.type === 'session.approval-requested') {
        const requestId = e.payload?.requestId;
        const r = await session.respondApproval({ requestId, decision: 'accept' });
        assert.ok(r.ok, 'respondApproval accepted');
        responded = true;
        if (await waitForPath(outFile)) break;
      }
      if (e.type === 'session.ended' || e.type === 'session.dead') break;
    }
  } finally {
    clearTimeout(deadline);
    await session.end().catch(/** Handle the expected rejection. */ () => {});
  }

  if (skipIfLiveUnavailable(t, events, 'codex', 'codex approval')) return;
  assert.ok(responded, 'codex surfaced an approval request');
  assert.ok(fs.existsSync(outFile), 'the approved command actually executed (file written)');
  fs.rmSync(cwd, { recursive: true, force: true });
});
