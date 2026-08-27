/**
 * Live orchestrator control coverage against the real Codex harness. This is intentionally a live
 * prerequisite test: owned-session branches require an actual session handle, and the project policy
 * forbids inventing a harness just to exercise those paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { key } from 'sumo/db';
import { plugin } from 'sumo/plugin';
import { Codex } from 'sumo/harness';
import { waitUntil } from 'sumo/util';
import { Orchestrator } from '../src/index.mjs';
import { assertAvailable } from '../../harness/test/_live.mjs';
import { closeTempDb, openTempDb } from 'sumo/util/testing';

const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/**
 * Skip a live Codex test when provider selection or session startup reaches the real binary but the
 * external prerequisite is unavailable in this environment.
 * @param {{ ok: boolean, code?: string, reason?: string }} result
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {boolean}
 */
function skipUnavailableSpawn(result, t, label) {
  if (result?.ok) return false;
  const reason = String(result?.reason ?? '');
  if (
    LIVE_UNAVAILABLE.has(result?.code)
    || (result?.code === 'SUMO_NO_HARNESS' && /\bcodex\b/i.test(reason) && /(login|auth|rate|budget|backend|overload|unavailable|exit null)/i.test(reason))
  ) {
    t.skip(`${label} live prerequisite unavailable: ${result?.code}${reason ? ` - ${reason}` : ''}`);
    return true;
  }
  return false;
}

/**
 * Wait for a real assistant message, or skip when the real live backend reports a classified
 * prerequisite failure such as quota, auth, budget, backend availability, or service overload.
 * @param {any} db
 * @param {string} sessionId
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {Promise<boolean>} true when an assistant message arrived; false when the test was skipped.
 */
async function waitForAssistantOrLiveSkip(db, sessionId, t, label) {
  let unavailableCode;
  await waitUntil(/** Run the callback. */ async () => {
    for await (const [, event] of db.scan('evt:')) {
      if (event.sessionId !== sessionId) continue;
      if (event.type === 'session.message' && event.payload?.role === 'assistant') return true;
      const code = event.ext?.classification?.code ?? event.payload?.sumoCode;
      if (LIVE_UNAVAILABLE.has(code)) {
        unavailableCode = code;
        return true;
      }
    }
    return false;
  }, 120_000);

  if (unavailableCode) {
    t.skip(`${label} live prerequisite unavailable: ${unavailableCode}`);
    return false;
  }
  return true;
}

/** Implement waitForFileOrLiveSkip. */ async function waitForFileOrLiveSkip(db, file, sessionId, t, label, timeoutMs = 120_000) {
  let unavailableCode;
  await waitUntil(/** Run the callback. */ async () => {
    if (fs.existsSync(file)) return true;
    for await (const [, event] of db.scan('evt:')) {
      if (event.sessionId !== sessionId) continue;
      const code = event.ext?.classification?.code ?? event.payload?.sumoCode;
      if (LIVE_UNAVAILABLE.has(code)) {
        unavailableCode = code;
        return true;
      }
    }
    return false;
  }, timeoutMs);

  if (unavailableCode) {
    t.skip(`${label} live prerequisite unavailable: ${unavailableCode}`);
    return false;
  }
  return true;
}

/** Implement waitForTurnCompleteOrLiveSkip. */ async function waitForTurnCompleteOrLiveSkip(db, sessionId, t, label, timeoutMs = 120_000) {
  let unavailableCode;
  await waitUntil(/** Run the callback. */ async () => {
    for await (const [, event] of db.scan('evt:')) {
      if (event.sessionId !== sessionId) continue;
      if (event.type === 'session.raw:turn.completed' || event.type === 'session.turn-completed') return true;
      const code = event.ext?.classification?.code ?? event.payload?.sumoCode;
      if (LIVE_UNAVAILABLE.has(code)) {
        unavailableCode = code;
        return true;
      }
    }
    return false;
  }, timeoutMs);

  if (unavailableCode) {
    t.skip(`${label} live prerequisite unavailable: ${unavailableCode}`);
    return false;
  }
  return true;
}

/** Implement waitForProofOfLifeOrLiveSkip. */ async function waitForProofOfLifeOrLiveSkip(db, sessionId, t, label, timeoutMs = 10_000) {
  let unavailableCode;
  await waitUntil(/** Run the callback. */ async () => {
    for await (const [, event] of db.scan('evt:')) {
      if (event.type === 'orchestrator.surfaced' && event.payload?.reason === 'proof-of-life answer' && event.payload?.agent === sessionId) return true;
      if (event.sessionId !== sessionId) continue;
      const code = event.ext?.classification?.code ?? event.payload?.sumoCode;
      if (LIVE_UNAVAILABLE.has(code)) {
        unavailableCode = code;
        return true;
      }
    }
    return false;
  }, timeoutMs);

  if (unavailableCode) {
    t.skip(`${label} live prerequisite unavailable: ${unavailableCode}`);
    return false;
  }
  return true;
}

test('LIVE codex: orchestrator owns and controls a real session handle', { timeout: 180_000 }, /** Verify LIVE codex: orchestrator owns and controls a real session handle. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  const ctx = await openTempDb();
  const runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: { harness: { codex: cfg } }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: 'Reply with exactly: ORCH',
      harness: 'codex',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'codex orchestrator')) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    const liveDeadline = setTimeout(/** Run the timer callback. */ () => {
      orch.control(sessionId, 'end', { force: true }).catch(/** Handle the expected rejection. */ () => {});
    }, 110_000);
    try {
      if (!await waitForAssistantOrLiveSkip(ctx.db, sessionId, t, 'codex orchestrator')) return;
    } finally {
      clearTimeout(liveDeadline);
    }

    await ctx.db.append({
      dedupe: `codex-live:proof-of-life:${sessionId}`,
      type: 'messenger.proof-of-life-request',
      source: 'messenger',
      payload: { agent: sessionId }
    });
    if (!await waitForProofOfLifeOrLiveSkip(ctx.db, sessionId, t, 'codex orchestrator')) return;

    const keyResult = await orch.control(sessionId, 'key', { name: 'Enter' });
    assert.equal(keyResult.ok, false);
    assert.equal(keyResult.code, 'SUMO_CAP_UNSUPPORTED');

    const sent = await orch.control(sessionId, 'send', { text: 'Reply with exactly: SECOND' });
    assert.equal(sent.ok, true, JSON.stringify(sent));

    const unknown = await orch.control(sessionId, 'not-a-control-op', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'SUMO_BAD_OP');

    const cancelled = await orch.control(sessionId, 'cancel', {});
    assert.ok(cancelled.ok === true || cancelled.code === 'SUMO_MEDIUM_ERROR', JSON.stringify(cancelled));

    const ended = await orch.control(sessionId, 'end', { force: true });
    assert.equal(ended.ok, true, JSON.stringify(ended));

    await waitUntil(/** Run the callback. */ async () => {
      const done = await orch.control(sessionId, 'send', { text: 'after end' });
      return done.ok === false && done.code === 'SUMO_SESSION_DEAD';
    }, 10_000);
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
  }
});

test('LIVE codex: owned control paths do not require a completed assistant turn', { timeout: 180_000 }, /** Verify LIVE codex: owned control paths do not require a completed assistant turn. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  const ctx = await openTempDb();
  const runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: { harness: { codex: cfg } }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: 'Reply with exactly: CONTROL',
      harness: 'codex',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'codex owned-control')) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    await ctx.db.append({
      dedupe: `codex-live:pre-wait-proof-of-life:${sessionId}`,
      type: 'messenger.proof-of-life-request',
      source: 'messenger',
      payload: { agent: sessionId }
    });
    if (!await waitForProofOfLifeOrLiveSkip(ctx.db, sessionId, t, 'codex owned-control')) return;

    const sent = await orch.control(sessionId, 'send', { text: 'Reply with exactly: CONTROL SECOND' });
    assert.equal(sent.ok, true, JSON.stringify(sent));

    const keyResult = await orch.control(sessionId, 'key', { name: 'Enter' });
    assert.equal(keyResult.ok, false);
    assert.equal(keyResult.code, 'SUMO_CAP_UNSUPPORTED');

    const defaultKeyResult = await orch.control(sessionId, 'key', {});
    assert.equal(defaultKeyResult.ok, false);
    assert.equal(defaultKeyResult.code, 'SUMO_CAP_UNSUPPORTED');

    const unknown = await orch.control(sessionId, 'not-a-control-op', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'SUMO_BAD_OP');

    const cancelled = await orch.control(sessionId, 'cancel', {});
    assert.ok(cancelled.ok === true || cancelled.code === 'SUMO_MEDIUM_ERROR', JSON.stringify(cancelled));

    const ended = await orch.control(sessionId, 'end', { force: true });
    assert.equal(ended.ok, true, JSON.stringify(ended));

    await waitUntil(/** Run the callback. */ async () => {
      const dead = await orch.control(sessionId, 'send', { text: 'after end' });
      return dead.ok === false && dead.code === 'SUMO_SESSION_DEAD';
    }, 10_000);
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
  }
});

test('LIVE codex: unavailable Cursor request fails over to real Codex and records the session', { timeout: 180_000 }, /** Verify LIVE codex: unavailable Cursor request fails over to real Codex and records the session. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  const ctx = await openTempDb();
  const runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        cursor: { bin: '/nonexistent/sumo-live-cursor' },
        codex: cfg,
        fallback: ['codex']
      }
    }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: 'Reply with exactly: FALLBACK',
      harness: 'cursor',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'codex failover')) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    let doc;
    await waitUntil(/** Run the callback. */ async () => {
      doc = await ctx.db.get(key(sessionId));
      return doc?.requestedHarness === 'cursor' && doc.ext?.failover === true;
    }, 10_000);
    assert.equal(doc.requestedHarness, 'cursor');
    assert.equal(doc.ext?.failover, true);

    if (!await waitForAssistantOrLiveSkip(ctx.db, sessionId, t, 'codex failover')) return;

    const ended = await orch.control(sessionId, 'end', { force: true });
    assert.equal(ended.ok, true, JSON.stringify(ended));
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
  }
});

test('LIVE codex: orchestrator approval policy answers the real app-server approval request', { timeout: 150_000 }, /** Verify LIVE codex: orchestrator approval policy answers the real app-server approval request. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  /** Implement approvalPolicy. */ function approvalPolicy(sumo) {
    sumo.modify('approval', /** Run the callback. */ () => ({ action: 'allow' }));
  }
  approvalPolicy.sumo = { name: 'codex-approval-policy' };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-orch-codex-approval-'));
  const outFile = path.join(cwd, 'out.txt');
  const ctx = await openTempDb();
  const runtime = plugin({
    cwd,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        codex: {
          ...cfg,
          cwd,
          sandbox: 'read-only',
          approvalPolicy: 'on-request'
        }
      }
    }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    runtime.sumo.use(approvalPolicy);
    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: `Write the text hi into ${outFile} using the shell tool. The sandbox is read-only, so request approval.`,
      harness: 'codex',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'codex approval')) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    if (!await waitForFileOrLiveSkip(ctx.db, outFile, sessionId, t, 'codex approval')) return;
    assert.equal(fs.readFileSync(outFile, 'utf8').trim(), 'hi');

    const approvals = [];
    for await (const [, event] of ctx.db.scan('evt:')) {
      if (event.type === 'session.approval-requested' && event.sessionId === sessionId) approvals.push(event);
    }
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].payload.requestId, 0);

    const ended = await orch.control(sessionId, 'end', { force: true });
    assert.equal(ended.ok, true, JSON.stringify(ended));
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('LIVE codex: orchestrator denial policy cancels a real app-server approval request', { timeout: 150_000 }, /** Verify LIVE codex: orchestrator denial policy cancels a real app-server approval request. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  /** Implement approvalPolicy. */ function approvalPolicy(sumo) {
    sumo.modify('approval', /** Run the callback. */ () => ({ action: 'deny', reason: 'live policy denial' }));
  }
  approvalPolicy.sumo = { name: 'codex-approval-denial-policy' };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-orch-codex-denial-'));
  const outFile = path.join(cwd, 'denied.txt');
  const ctx = await openTempDb();
  const runtime = plugin({
    cwd,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        codex: {
          ...cfg,
          cwd,
          sandbox: 'read-only',
          approvalPolicy: 'on-request'
        }
      }
    }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    runtime.sumo.use(approvalPolicy);
    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: `Write the text denied into ${outFile} using the shell tool. The sandbox is read-only, so request approval.`,
      harness: 'codex',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'codex approval denial')) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    if (!await waitForTurnCompleteOrLiveSkip(ctx.db, sessionId, t, 'codex approval denial')) return;
    assert.equal(fs.existsSync(outFile), false);

    const approvals = [];
    for await (const [, event] of ctx.db.scan('evt:')) {
      if (event.type === 'session.approval-requested' && event.sessionId === sessionId) approvals.push(event);
    }
    assert.equal(approvals.length, 1);
    assert.ok(approvals[0].payload.availableDecisions.some(/** Test whether an item matches. */ (decision) => decision === 'cancel'));

    const ended = await orch.control(sessionId, 'end', { force: true });
    assert.equal(ended.ok, true, JSON.stringify(ended));
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
