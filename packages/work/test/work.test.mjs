import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { plugin } from 'sumo/plugin';
import { open } from 'sumo/db';
import { start } from 'sumo/db/daemon';
import { register as registerWork } from 'sumo/work';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(async () => {
  ctx = await openTempDb();
});
after(async () => {
  await closeTempDb(ctx);
});

function runtime(config = {}) {
  return plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db, config });
}

async function appendWork(id = 'work_abc', opts = {}) {
  await appendWorkTo(ctx.db, id, opts);
}

async function appendWorkTo(db, id = 'work_abc', opts = {}) {
  await db.append({
    dedupe: `test:work:${id}`,
    type: 'work.appeared',
    source: 'messenger',
    adapter: 'github',
    payload: {
      workRef: id,
      ...(opts.noExternal ? {} : { externalId: opts.externalId ?? 'owner/repo#12' }),
      kind: 'task',
      ...(opts.inlineOnly ? {} : { work: {
        id,
        ...(opts.noExternal ? {} : { externalId: opts.externalId ?? 'owner/repo#12' }),
        title: opts.title ?? 'Fix it',
        body: opts.body ?? 'body',
        kind: 'task',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.noExt ? {} : { ext: {
          repo: opts.repo ?? 'owner/repo',
          number: opts.number ?? 12
        } })
      } })
    }
  });
}

async function claimWorkTo(db, id, agent = 'agent') {
  await db.append({
    dedupe: `test:claim:${id}:${agent}`,
    type: 'work.claimed',
    source: 'messenger',
    payload: { workRef: id, agent }
  });
}

function workCapabilities(deps = {}) {
  const commands = new Map();
  registerWork({ command: (capability) => commands.set(capability.name, capability) }, deps);
  return commands;
}

test('work.detect scores available and empty work states', async () => {
  const empty = runtime();
  await empty.start();
  try {
    assert.deepEqual(await empty.invoke('work.detect', { timeoutMs: 0 }), {
      ok: true,
      value: {
        pass: false,
        message: 'no actionable work available'
      }
    });
  } finally {
    await empty.stop();
  }

  await appendWork();
  const rt = runtime();
  await rt.start();
  try {
    const result = await rt.invoke('work.detect', { timeoutMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.value.pass, true);
    assert.equal(result.value.workRef, 'work_abc');
    assert.equal(result.value.work.title, 'Fix it');
  } finally {
    await rt.stop();
  }
});

test('work.released scores no-work and released states', async () => {
  const clean = await openTempDb();
  const cleanRt = plugin({ cwd: clean.home, flags: {}, env: {}, db: clean.db });
  await cleanRt.start();
  try {
    const result = await cleanRt.invoke('work.released', {});
    assert.equal(result.ok, true);
    assert.equal(result.value.pass, true);
    assert.equal(result.value.message, 'no work was available');
  } finally {
    await cleanRt.stop().catch(() => {});
    await closeTempDb(clean);
  }

  const noWork = runtime();
  await noWork.start();
  try {
    const result = await noWork.invoke('work.released', {});
    assert.equal(result.ok, true);
    assert.equal(result.value.pass, false, 'previous test seeded work in shared db');
  } finally {
    await noWork.stop();
  }

  await ctx.db.append({
    dedupe: 'test:release:work_abc',
    type: 'work.released',
    source: 'messenger',
    payload: {
      workRef: 'work_abc',
      outcome: {
        status: 'done'
      }
    }
  });

  const rt = runtime();
  await rt.start();
  try {
    const result = await rt.invoke('work.released', { workRef: 'work_abc' });
    assert.equal(result.ok, true);
    assert.equal(result.value.pass, true);
  } finally {
    await rt.stop();
  }
});

test('work claim, release and review expose operational outcomes', async () => {
  const rt = runtime();
  await rt.start();
  try {
    const missingClaim = await rt.invoke('work.claim', { workRef: 'missing-work', timeoutMs: 0 });
    assert.equal(missingClaim.ok, true);
    assert.equal(missingClaim.value.ok, false);
    assert.equal(missingClaim.value.code, 'SUMO_CAP_UNSUPPORTED');

    await appendWork('work_ops', { inlineOnly: true, title: 'Inline work' });

    const claim = await rt.invoke('work.claim', { workRef: 'work_ops', timeoutMs: 0 });
    assert.equal(claim.ok, true);
    assert.equal(claim.value.ok, false);
    assert.match(claim.value.reason, /plugins\.github config/);

    const release = await rt.invoke('work.release', { workRef: 'work_ops' });
    assert.equal(release.ok, true);
    assert.equal(release.value.ok, false);
    assert.match(release.value.reason, /plugins\.github config/);

    const reviewPass = await rt.invoke('work.review', { workRef: 'work_ops', verdict: 'pass', timeoutMs: 1 });
    assert.equal(reviewPass.ok, true);
    assert.equal(reviewPass.value.pass, false);
    assert.match(reviewPass.value.message, /plugins\.github config/);

    const reviewChanges = await rt.invoke('work.review', { workRef: 'work_ops', verdict: 'request-changes', timeoutMs: 1 });
    assert.equal(reviewChanges.ok, true);
    assert.equal(reviewChanges.value.pass, false);
  } finally {
    await rt.stop();
  }
});

test('work.detect ignores released work when later work is available', async () => {
  const clean = await openTempDb();
  const rt = plugin({ cwd: clean.home, flags: {}, env: {}, db: clean.db });
  try {
    await appendWorkTo(clean.db, 'work_done', { title: 'Done' });
    await clean.db.append({
      dedupe: 'test:release:work_done',
      type: 'work.released',
      source: 'messenger',
      payload: {
        workRef: 'work_done'
      }
    });
    await appendWorkTo(clean.db, 'work_next', { title: 'Next' });

    await rt.start();
    const result = await rt.invoke('work.detect', { timeoutMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.value.pass, true);
    assert.equal(result.value.workRef, 'work_next');
  } finally {
    await rt.stop().catch(() => {});
    await closeTempDb(clean);
  }
});

test('work.detect waits for delayed work and indexes lifecycle variants', async () => {
  const clean = await openTempDb();
  const rt = plugin({ cwd: clean.home, flags: {}, env: {}, db: clean.db });
  try {
    await clean.db.put('evt:manual:missing-seq', {
      type: 'work.appeared',
      source: 'messenger'
    });
    await appendWorkTo(clean.db, 'work_index', {
      title: 'Index me',
      noExt: true
    });
    await clean.db.append({
      dedupe: 'test:claim:work_index',
      type: 'work.claimed',
      source: 'messenger',
      payload: {
        workRef: 'work_index'
      }
    });
    await clean.db.append({
      dedupe: 'test:review:work_index',
      type: 'work.review-posted',
      source: 'messenger',
      payload: {
        workRef: 'work_index'
      }
    });

    await rt.start();
    const indexed = await rt.invoke('work.detect', {
      workRef: 'work_index',
      timeoutMs: 0
    });
    assert.equal(indexed.ok, true);
    assert.equal(indexed.value.pass, true);
    assert.equal(indexed.value.workRef, 'work_index');

    await clean.db.append({
      dedupe: 'test:release:work_index',
      type: 'work.released',
      source: 'messenger',
      payload: {
        workRef: 'work_index'
      }
    });
    const waiter = rt.invoke('work.detect', {
      timeoutMs: 500
    });
    await appendWorkTo(clean.db, 'work_delayed', {
      title: 'Delayed'
    });
    const delayed = await waiter;
    assert.equal(delayed.ok, true);
    assert.equal(delayed.value.pass, true);
    assert.equal(delayed.value.workRef, 'work_delayed');
  } finally {
    await rt.stop().catch(() => {});
    await closeTempDb(clean);
  }
});

test('work.run uses the real daemon session control boundary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-work-run-'));
  const daemon = await start({
    home,
    idleShutdownMs: 0,
    onSession: async (req) => ({
      ok: true,
      value: {
        id: 'ses_worker',
        request: req
      }
    })
  });
  const db = await open({ home, autostart: false });
  const rt = plugin({ cwd: home, flags: {}, env: {}, db });
  try {
    await db.append({
      dedupe: 'test:work:run',
      type: 'work.appeared',
      source: 'messenger',
      adapter: 'github',
      payload: {
        workRef: 'work_run',
        work: {
          id: 'work_run',
          externalId: 'owner/repo#15',
          title: 'Run it',
          body: 'Body',
          cwd: home,
          ext: {
            repo: 'owner/repo',
            number: 15
          }
        }
      }
    });
    await rt.start();
    await claimWorkTo(db, 'work_run');
    const result = await rt.invoke('work.run', { workRef: 'work_run', prompt: 'Do it', harness: 'copilot', model: 'm', timeoutMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.value.sessionId, 'ses_worker');
    assert.equal(result.value.workRef, 'work_run');

    const released = await rt.invoke('work.released', { workRef: 'work_run' });
    assert.equal(released.ok, true);
    assert.equal(released.value.pass, false);
  } finally {
    await rt.stop().catch(() => {});
    await db.close().catch(() => {});
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('work.run handles default prompt, sessionId shape, and spawn failures', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-work-run-branches-'));
  const requests = [];
  const daemon = await start({
    home,
    idleShutdownMs: 0,
    onSession: async (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return {
          ok: true,
          value: {
            sessionId: 'ses_worker_branch'
          }
        };
      }
      if (requests.length === 2) {
        return {
          ok: true,
          value: 'started'
        };
      }
      if (requests.length === 3) {
        return {
          ok: true,
          value: {}
        };
      }
      return {
        ok: false,
        code: 'SUMO_VERIFY_FAILED',
        reason: 'spawn denied'
      };
    }
  });
  const db = await open({ home, autostart: false });
  const rt = plugin({ cwd: home, flags: {}, env: {}, db });
  try {
    await appendWorkTo(db, 'work_default', {
      title: 'Default prompt',
      body: 'Use the body as context.'
    });
    await appendWorkTo(db, 'work_failed', {
      title: 'Failed spawn',
      body: 'This spawn fails.'
    });
    await appendWorkTo(db, 'work_input_cwd', {
      title: 'Input cwd',
      body: ''
    });
    await appendWorkTo(db, 'work_titleless', {
      inlineOnly: true
    });
    await Promise.all(['work_default', 'work_failed', 'work_input_cwd', 'work_titleless'].map((id) => claimWorkTo(db, id)));

    await rt.start();
    const spawned = await rt.invoke('work.run', {
      workRef: 'work_default',
      harness: 'codex',
      reasoningEffort: 'high',
      timeoutMs: 0
    });
    assert.equal(spawned.ok, true);
    assert.equal(spawned.value.sessionId, 'ses_worker_branch');
    assert.equal(requests[0].cwd, home);
    assert.equal(requests[0].payload.cwd, home);
    assert.equal(requests[0].payload.harness, 'codex');
    assert.equal(requests[0].payload.reasoningEffort, 'high');
    assert.match(requests[0].payload.prompt, /Work item: Default prompt/);
    assert.match(requests[0].payload.prompt, /Use the body as context\./);

    const customCwd = path.join(home, 'custom');
    const valueWithoutRecord = await rt.invoke('work.run', {
      workRef: 'work_input_cwd',
      cwd: customCwd,
      timeoutMs: 0
    });
    assert.equal(valueWithoutRecord.ok, true);
    assert.equal(valueWithoutRecord.value.sessionId, undefined);
    assert.equal(requests[1].cwd, customCwd);
    assert.equal(requests[1].payload.cwd, customCwd);

    const missingSessionId = await rt.invoke('work.run', {
      workRef: 'work_titleless',
      timeoutMs: 0
    });
    assert.equal(missingSessionId.ok, true);
    assert.equal(missingSessionId.value.sessionId, undefined);
    assert.match(requests[2].payload.prompt, /Work item: work_titleless/);
    assert.doesNotMatch(requests[2].payload.prompt, /undefined/);

    const failed = await rt.invoke('work.run', {
      workRef: 'work_failed',
      prompt: 'fail',
      timeoutMs: 0
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.value.ok, false);
    assert.equal(failed.value.code, 'SUMO_VERIFY_FAILED');
  } finally {
    await rt.stop().catch(() => {});
    await db.close().catch(() => {});
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('work capabilities can own their transient db connection', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-work-own-db-'));
  const previousHome = process.env.SUMO_HOME;
  process.env.SUMO_HOME = home;
  const commands = workCapabilities();
  const seeded = await open({ home, idleShutdownMs: 0 });
  try {
    await appendWorkTo(seeded, 'work_owned', {
      title: 'Owned connection',
      body: '',
      noExt: true
    });
    await appendWorkTo(seeded, 'work_title_fallback', {
      inlineOnly: true
    });
    await seeded.close();

    const detect = await commands.get('work.detect').exec({ workRef: 'work_owned', timeoutMs: 0 });
    assert.equal(detect.pass, true);
    assert.equal(detect.message, 'work available: Owned connection');

    const fallbackTitle = await commands.get('work.detect').exec({ workRef: 'work_title_fallback', timeoutMs: 0 });
    assert.equal(fallbackTitle.pass, true);
    assert.equal(fallbackTitle.message, 'work available: work_title_fallback');

    const claim = await commands.get('work.claim').exec({ workRef: 'work_owned', timeoutMs: 0 });
    assert.equal(claim.ok, false);
    assert.match(claim.reason, /plugins\.github config/);

    const unclaimed = await commands.get('work.run').exec({ workRef: 'work_title_fallback', timeoutMs: 0 }, {});
    assert.equal(unclaimed.ok, false);
    assert.match(unclaimed.reason, /must be claimed/);

    const run = await commands.get('work.run').exec({ workRef: 'missing', timeoutMs: 0 }, {});
    assert.equal(run.ok, false);
    assert.equal(run.reason, 'no work item available to run');

    const review = await commands.get('work.review').exec({ workRef: 'missing', verdict: 'pass', timeoutMs: 1 });
    assert.equal(review.pass, false);
    assert.equal(review.message, 'no work item available to review');

    const release = await commands.get('work.release').exec({ workRef: 'missing' });
    assert.equal(release.ok, false);
    assert.equal(release.reason, 'no work item available to release');

    const released = await commands.get('work.released').exec({ workRef: 'work_owned' });
    assert.equal(released.pass, false);
    assert.equal(released.message, 'not released work_owned');
  } finally {
    if (previousHome === undefined) delete process.env.SUMO_HOME;
    else process.env.SUMO_HOME = previousHome;
    await seeded.close().catch(() => {});
    const closer = await open({ home, autostart: false }).catch(() => undefined);
    await closer?.shutdown().catch(() => {});
    await closer?.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('work capabilities surface configured GitHub boundary failures', async () => {
  const clean = await openTempDb();
  const rt = plugin({
    cwd: clean.home,
    flags: {},
    env: {},
    db: clean.db,
    config: {
      plugins: {
        github: {
          repo: 'owner/repo',
          settleMs: 0,
          trust: 'all',
          agent: 'configured-agent'
        }
      }
    }
  });
  try {
    await appendWorkTo(clean.db, 'work_github', {
      externalId: 'owner/repo#41',
      title: 'Needs GitHub',
      noExt: true
    });
    await appendWorkTo(clean.db, 'work_github_ext', {
      externalId: 'owner/repo#42',
      title: 'Needs GitHub ext',
      repo: 'owner/repo',
      number: 42
    });
    await appendWorkTo(clean.db, 'work_github_no_external', {
      title: 'Needs GitHub fallback number',
      noExt: true,
      noExternal: true
    });

    await rt.start();
    const claim = await rt.invoke('work.claim', {
      workRef: 'work_github',
      timeoutMs: 0
    });
    assert.equal(claim.ok, true);
    assert.equal(claim.value.ok, false);
    assert.match(claim.value.reason, /gh|GitHub|api|auth|owner\/repo/i);

    const extClaim = await rt.invoke('work.claim', {
      workRef: 'work_github_ext',
      timeoutMs: 0
    });
    assert.equal(extClaim.ok, true);
    assert.equal(extClaim.value.ok, false);
    assert.match(extClaim.value.reason, /gh|GitHub|api|auth|owner\/repo/i);

    const noExternalClaim = await rt.invoke('work.claim', {
      workRef: 'work_github_no_external',
      timeoutMs: 0
    });
    assert.equal(noExternalClaim.ok, true);
    assert.equal(noExternalClaim.value.ok, false);
    assert.match(noExternalClaim.value.reason, /gh|GitHub|api|auth|owner\/repo/i);

    const review = await rt.invoke('work.review', {
      workRef: 'work_github',
      verdict: 'request-changes',
      timeoutMs: 1
    });
    assert.equal(review.ok, true);
    assert.equal(review.value.pass, false);
    assert.match(review.value.message, /gh|GitHub|api|auth|owner\/repo/i);

    const reviewPass = await rt.invoke('work.review', {
      workRef: 'work_github_ext',
      verdict: 'pass',
      timeoutMs: 1
    });
    assert.equal(reviewPass.ok, true);
    assert.equal(reviewPass.value.pass, false);
    assert.match(reviewPass.value.message, /gh|GitHub|api|auth|owner\/repo/i);

    const release = await rt.invoke('work.release', {
      workRef: 'work_github',
      outcome: {
        status: 'done'
      }
    });
    assert.equal(release.ok, true);
    assert.equal(release.value.ok, false);
    assert.match(release.value.reason, /gh|GitHub|api|auth|owner\/repo/i);

    const defaultRelease = await rt.invoke('work.release', {
      workRef: 'work_github_ext'
    });
    assert.equal(defaultRelease.ok, true);
    assert.equal(defaultRelease.value.ok, false);
    assert.match(defaultRelease.value.reason, /gh|GitHub|api|auth|owner\/repo/i);
  } finally {
    await rt.stop().catch(() => {});
    await closeTempDb(clean);
  }
});

test('work.review waits on recorded worker sessions and reports timeouts', async () => {
  const clean = await openTempDb();
  const rt = plugin({ cwd: clean.home, flags: {}, env: {}, db: clean.db });
  try {
    await appendWorkTo(clean.db, 'work_review_wait', { title: 'Review wait' });
    await clean.db.append({
      dedupe: 'test:run:work_review_wait',
      type: 'work.run-started',
      source: 'plugin',
      payload: {
        workRef: 'work_review_wait',
        sessionId: 'ses_review_done'
      }
    });
    await clean.db.put('ses:ses_review_done', {
      id: 'ses_review_done',
      harness: 'codex',
      state: 'ended',
      createdAt: 1,
      updatedAt: 2,
      ext: {}
    });
    await appendWorkTo(clean.db, 'work_review_dead', { title: 'Review dead' });
    await clean.db.append({
      dedupe: 'test:run:work_review_dead',
      type: 'work.run-started',
      source: 'plugin',
      payload: {
        workRef: 'work_review_dead',
        sessionId: 'ses_review_dead'
      }
    });
    await clean.db.put('ses:ses_review_dead', {
      id: 'ses_review_dead',
      harness: 'codex',
      state: 'dead',
      createdAt: 1,
      updatedAt: 2,
      ext: {}
    });

    await appendWorkTo(clean.db, 'work_review_timeout', { title: 'Review timeout' });
    await clean.db.append({
      dedupe: 'test:run:work_review_timeout',
      type: 'work.run-started',
      source: 'plugin',
      payload: {
        workRef: 'work_review_timeout',
        sessionId: 'ses_review_running'
      }
    });
    await clean.db.put('ses:ses_review_running', {
      id: 'ses_review_running',
      harness: 'codex',
      state: 'running',
      createdAt: 1,
      updatedAt: 2,
      ext: {}
    });

    await rt.start();
    const passed = await rt.invoke('work.review', {
      workRef: 'work_review_wait',
      verdict: 'pass',
      timeoutMs: 1
    });
    assert.equal(passed.ok, true);
    assert.equal(passed.value.pass, false);
    assert.match(passed.value.message, /plugins\.github config/);
    assert.equal(passed.value.workRef, 'work_review_wait');

    const dead = await rt.invoke('work.review', {
      workRef: 'work_review_dead',
      verdict: 'pass'
    });
    assert.equal(dead.ok, true);
    assert.equal(dead.value.pass, false);
    assert.match(dead.value.message, /plugins\.github config/);

    const timedOut = await rt.invoke('work.review', {
      workRef: 'work_review_timeout',
      verdict: 'pass',
      timeoutMs: 1
    });
    assert.equal(timedOut.ok, true);
    assert.equal(timedOut.value.pass, false);
    assert.match(timedOut.value.message, /did not finish before review timeout/);
  } finally {
    await rt.stop().catch(() => {});
    await closeTempDb(clean);
  }
});
