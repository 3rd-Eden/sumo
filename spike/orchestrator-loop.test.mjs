/**
 * Orchestrator loop — LIVE end-to-end, the integration proof that the orchestrator GENERALIZES the
 * 1.0-join loop. The proven loop (work → claim → run → observe → release) now runs via the orchestrator
 * against real GitHub, driving TWO harness kinds through the SAME unchanged orchestrator: a pipe-kind
 * Claude worker AND a server-kind Codex reviewer. If a harness-shaped assumption had leaked into core,
 * the server-kind run would break while the pipe-kind passed. All real — no mocks, no skips (§5).
 *
 * Harnesses are auto-registered by core (no plugins); the workflow is inlined as a test fixture (it's
 * a demonstration, not a feature).
 *
 * Requires:
 * - a real `claude` binary accepting stream-json args
 * - a real `codex` binary supporting `codex app-server`
 * - `SUMO_GITHUB_TEST_REPO=owner/repo`
 * - `gh` CLI authenticated with write access to that repository
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ID_REGEXP } from 'sumo/db';
import { plugin } from 'sumo/plugin';
import { Orchestrator } from 'sumo/orchestrator';

import github from '../plugins/github/index.mjs';
import { Codex } from '../packages/harness/src/index.mjs';

import { openTempDb, allEvents, settle, assertClaudeBin } from './_helpers.mjs';
import { assertAvailable } from '../packages/harness/test/_live.mjs';

// ── Inline demonstration workflow (adapter-neutral, ) ────────────────────────────────────────────
const OBSERVE_TIMEOUT_MS = 120_000;

/** Implement observe. */ async function observe(session, { untilMessage = false } = {}) {
  const events = [];
  if (!untilMessage) {
    for await (const evt of session.join()) events.push(evt);
    await session.done();
    return events;
  }
  let timer;
  const deadline = new Promise(/** Run the callback. */ (res) => { timer = setTimeout(res, OBSERVE_TIMEOUT_MS); timer.unref?.(); });
  const drain = (/** Run the callback. */ async () => {
    for await (const evt of session.join()) {
      events.push(evt);
      if (evt.type === 'session.message' && (evt.payload?.role ?? 'assistant') === 'assistant') break;
    }
  })();
  await Promise.race([drain, deadline]);
  clearTimeout(timer);
  try { await session.end?.(); } catch { /* best-effort reap */ }
  return events;
}

/** Implement demoWorkflow. */ function demoWorkflow(sumo, options = {}) {
  const { harness, reviewer, onComplete } = options;

  sumo.on('work', /** Run the callback. */ async (work) => {
    const claim = await work.claim();
    if (!claim.ok) return;

    let released = false;
    /** Implement release. */ async function release(outcome) {
      if (released) return;
      released = true;
      try { await work.release?.(outcome); } catch { /* best-effort */ }
    }

    try {
      const run = await sumo.run(work.body || work.title || '', { harness, spawnKey: work.id });
      if (!run.ok) {
        await release({ outcome: 'spawn-failed', code: run.code, reason: run.reason });
        onComplete?.({ ok: false, stage: 'worker', result: run });
        return;
      }
      const worker = run.value;
      const workerEvents = await observe(worker);

      let review;
      if (reviewer) {
        const handoff = `Review the work done for this task and reply APPROVE or REQUEST-CHANGES with a reason:\n\n${work.title ?? ''}`;
        const rr = await sumo.run(handoff, { harness: reviewer, spawnKey: `${work.id}:review` });
        if (rr.ok) {
          const reviewEvents = await observe(rr.value, { untilMessage: true });
          const text = reviewEvents.filter(/** Select matching items. */ (e) => e.type === 'session.message').map(/** Map one item. */ (e) => e.payload?.text ?? '').join('\n');
          review = { passed: /APPROVE/i.test(text), verdict: text };
          await work.review?.(review);
        }
      }

      const outcome = { outcome: 'completed', workerEvents: workerEvents.length, ...(review ? { reviewed: review.passed } : {}) };
      await release(outcome);
      onComplete?.({ ok: true, work, worker, workerEvents, review });
    } catch (e) {
      await release({ outcome: 'errored', reason: String(e?.message ?? e) });
      onComplete?.({ ok: false, error: e });
    }
  });
}
demoWorkflow.sumo = { name: 'demo-workflow' };

const exec = promisify(execFile);
const here = new URL('.', import.meta.url).pathname;

const PROMPT = 'Say exactly: hello sumo';
const TIMEOUT_MS = 180_000;
const REPO = process.env.SUMO_GITHUB_TEST_REPO?.trim();
// A UNIQUE per-run label scopes the poll to THIS run's single issue. The shared `sumo:ready` label
// accumulates across runs (a crashed run leaves its issue labeled), and the GraphQL `*work()` poll
// yields EVERY open issue carrying the filter label — so a shared label fans the loop out across the
// repo's backlog, spawning one worker per stale issue (most then orphaned when the test resolves on the
// first completion). A run-scoped label is discovered only here and is deleted on teardown.
const LABEL = `sumo:spike-${Date.now()}`;

/** Implement gh. */ function gh(args) { return exec('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }); }

test('health() answers four signals on a real live Claude session', { timeout: 120_000 }, /** Verify health() answers four signals on a real live Claude session. */ async (t) => {
  const claudeBin = await assertClaudeBin(t);
  if (!claudeBin) return;
  const { db, cleanup } = await openTempDb();
  let orch;
  try {
    const runtime = plugin({ cwd: here, db, config: { harness: { 'claude-code': { bin: claudeBin } } } });
    orch = new Orchestrator({ runtime, db });
    await runtime.start();

    const probe = await orch.run('Say hi briefly.', { harness: 'claude-code', spawnKey: 'health-probe' });
    assert.equal(probe.ok, true, 'probe session spawned');
    const verdict = await orch.health(probe.value);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.value.signals.process, true, 'process alive (no terminal event seen)');
    assert.equal(verdict.value.signals.activity, true, 'activity within the stall window');
    assert.equal(verdict.value.signals.state, 'running');
    assert.equal(verdict.value.alive, true);

    await probe.value.end({ force: true });
    await runtime.stop();
  } finally {
    if (orch) orch.stop();
    await cleanup();
  }
});

test('orchestrator runs the proven loop, harness-agnostic (Claude pipe + Codex server)', { timeout: TIMEOUT_MS + 60_000 }, /** Verify orchestrator runs the proven loop, harness-agnostic (Claude pipe + Codex server). */ async (t) => {
 // ── Preflight: skip on missing real dependencies (§5) ──────────────────────────────────────────
 if (!REPO) {
 t.skip('requires SUMO_GITHUB_TEST_REPO=owner/repo');
 return;
 }
 const claudeBin = await assertClaudeBin(t);
 if (!claudeBin) return;
 const codexCfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN }: {}, t);
 if (!codexCfg) return;
 const codexBin = codexCfg.bin ?? 'codex';
 const auth = await gh(['auth', 'status']).catch(/** Handle the expected rejection. */ (e) => { t.skip(`requires \`gh\` auth — run \`gh auth login\`: ${e.message}`); return null; });
 if (!auth) return;
 const repo = await gh(['repo', 'view', REPO]).catch(/** Handle the expected rejection. */ (e) => { t.skip(`requires access to ${REPO}: ${e.message}`); return null; });
 if (!repo) return;

 const { db, cleanup } = await openTempDb();
 let issueNumber;
 let orch;

 try {
 // The run-scoped ready label + the shared claim label must exist before `gh issue create --label`.
 await gh(['label', 'create', LABEL, '--repo', REPO, '--color', 'c2e0c6', '--force']).catch(/** Handle the expected rejection. */ () => {});
 await gh(['label', 'create', 'sumo:claimed', '--repo', REPO, '--color', 'ededed', '--force']).catch(/** Handle the expected rejection. */ () => {});

 const title = `[orchestrator-loop spike] ${Date.now()}`;
 const { stdout } = await gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', PROMPT, '--label', LABEL]);
 issueNumber = Number(stdout.trim().match(/(\d+)\s*$/)?.[1]);
 assert.ok(issueNumber > 0, `created issue #${issueNumber}`);

 // ── The workflow resolves this when the full loop (claim → worker → reviewer → release) completes ─
 let resolve, reject;
 const loopDone = new Promise(/** Run the callback. */ (res, rej) => { resolve = res; reject = rej; });
 const deadline = setTimeout(/** Run the timer callback. */ () => reject(new Error('orchestrator loop did not complete within timeout')), TIMEOUT_MS);

 // ── Wire the runtime + the orchestrator (the SOLE actor) BEFORE start ───────────────────────────
 const runtime = plugin({
 cwd: here, db,
 config: { harness: { 'claude-code': { bin: claudeBin }, codex: { bin: codexBin } } }
 });
 orch = new Orchestrator({ runtime, db });

 runtime.sumo.use(github, { repo: REPO, label: LABEL, claimLabel: 'sumo:claimed', settleMs: 2500, claimTtlMs: 4000, heartbeatMs: 1000 });
 // worker = Claude (pipe), reviewer = Codex (server) — both through the same orchestrator.
 runtime.sumo.use(demoWorkflow, { harness: 'claude-code', reviewer: 'codex', /** Implement onComplete. */ onComplete(r) { return (r.ok ? resolve(r): reject(r.error ?? new Error(`loop failed at ${r.stage}: ${JSON.stringify(r.result)}`))); } });

 await runtime.start();

 const result = await loopDone;
 clearTimeout(deadline);
 await settle();
 await new Promise(/** Run the callback. */ (r) => setTimeout(r, 200)); // fire-and-forget ses: doc patches

 await t.test('worker (Claude) produced session events', /** Verify worker (Claude) produced session events. */ () => {
 assert.match(result.worker.id, ID_REGEXP, 'worker session id is a Sumo ULID');
 assert.ok(result.workerEvents.length > 0, `worker produced ${result.workerEvents.length} events`);
 assert.ok(result.workerEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.message'), 'at least one session.message');
 for (const e of result.workerEvents) assert.equal(e.sessionId, result.worker.id, 'events carry the worker Sumo id');
 });

 await t.test('reviewer ran on a DIFFERENT (server-kind) harness — harness-agnostic proof', /** Verify reviewer ran on a DIFFERENT (server-kind) harness — harness-agnostic proof. */ async () => {
 const docs = [];
 for await (const [, doc] of db.scan('ses:')) docs.push(doc);
 const harnesses = new Set(docs.map(/** Map one item. */ (d) => d.harness));
 assert.ok(harnesses.has('claude-code'), 'a claude-code (pipe) session ran');
 assert.ok(harnesses.has('codex'), 'a codex (server) session ran through the same orchestrator');
 assert.ok(result.review, 'reviewer produced a verdict object');
 });

 await t.test('release succeeded — work.released event in the log', /** Verify release succeeded — work.released event in the log. */ async () => {
 const evts = await allEvents(db);
 const released = evts.find(/** Find a matching item. */ (e) => e.type === 'work.released');
 assert.ok(released, 'work.released event found');
 });

 await runtime.stop();
 } finally {
 if (orch) orch.stop();
 if (issueNumber) await gh(['issue', 'close', String(issueNumber), '--repo', REPO]).catch(/** Handle the expected rejection. */ () => {});
 // Delete the run-scoped label entirely — removes it from the issue and keeps the repo from
 // accumulating ready-labeled issues that the next run would fan out across.
 await gh(['label', 'delete', LABEL, '--repo', REPO, '--yes']).catch(/** Handle the expected rejection. */ () => {});
 await cleanup();
 }
});
