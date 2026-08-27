/**
 * Session document writer tests (spec 04 — spawn-time recording), LIVE against the real `claude`
 * subprocess. Verifies the `ses:` doc is written at spawn, updated when the native id is discovered,
 * and patched on lifecycle close. Uses a REAL temp daemon and the REAL `Claude` adapter — no mock
 * transport, no mock db (§3f/§5). Skips with a clear reason when no real binary is found.
 *
 * Each `test` spawns the real subprocess (a real model call), so assertions that inspect the same
 * resulting doc share a single run rather than re-spawning per assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { open, SessionSchema, ID_REGEXP } from 'sumo/db';
import { Claude } from '../src/index.mjs';
import { assertClaudeBin } from './_live.mjs';

const TIMEOUT_MS = 120_000;

/** Spin up a real daemon on a temp dir. */
async function openTempDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-harness-ses-'));
  const db = await open({ home, idleShutdownMs: 1000 });
  return {
    db,
    home,
    /** Implement cleanup. */ async cleanup() {
      await db.close();
      try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Let fire-and-forget patches settle (best-effort writes are void-ed). */
function settle() { return new Promise(/** Run the callback. */ (r) => setTimeout(r, 50)); }

/** Drive a real Claude session to completion against the given ctx; returns the Session + cwd. */
async function runClaude(ctx, t) {
  const bin = await assertClaudeBin(t);
  if (!bin) return null;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ses-cwd-'));
  const harness = new Claude({ ...ctx, config: { ...ctx.config, bin, cwd } });
  const session = await harness.run('Say exactly: hello sumo', { cwd });
  const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
  try {
    for await (const _ of session.join()) void _; // drain to completion (real subprocess exits)
  } finally {
    clearTimeout(deadline);
  }
  await session.done();
  await settle();
  return { session, cwd };
}

/** Implement docsOf. */ async function docsOf(db) {
  const out = [];
  for await (const [, doc] of db.scan('ses:')) out.push(doc);
  return out;
}

test('ses: doc lifecycle — written at spawn, native id recorded, ended on graceful close', { timeout: TIMEOUT_MS + 30_000 }, /** Verify ses: doc lifecycle — written at spawn, native id recorded, ended on graceful close. */ async (t) => {
  const { db, cleanup } = await openTempDb();
  let cwd;
  try {
    let session;
    const run = await runClaude({ db }, t);
    if (!run) return;
    ({ session, cwd } = run);
    const docs = await docsOf(db);
    assert.equal(docs.length, 1, 'exactly one ses: doc');

    const doc = docs[0];
    // written at spawn, schema-valid, ULID id matching the live Session id
    assert.match(doc.id, ID_REGEXP);
    assert.equal(doc.id, session.id);
    assert.equal(doc.harness, 'claude-code');
    assert.equal(typeof doc.createdAt, 'number');
    assert.equal(typeof doc.updatedAt, 'number');
    assert.ok(doc.cwd);
    // : the recorded cwd is reconciled to where the process ACTUALLY ran (the init frame's cwd),
    // not just the requested value. realpath both sides — macOS tmp is a /private symlink and Claude
    // reports the resolved path.
    assert.equal(fs.realpathSync(doc.cwd), fs.realpathSync(cwd), 'doc.cwd is the cwd the harness reported running in');
    SessionSchema.parse(doc);

    // updated with the native id from the real init frame
    assert.equal(typeof doc.harnessSessionId, 'string');
    assert.ok(doc.harnessSessionId.length > 0, 'native session id recorded');

    // and the harness-computed transcript path — derivable for Claude from (nativeId, init-frame cwd),
    // honoring CLAUDE_CONFIG_DIR. It must point at the REAL on-disk transcript that Claude just wrote.
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    assert.equal(typeof doc.transcriptPath, 'string', 'transcriptPath recorded by the harness');
    assert.ok(doc.transcriptPath.startsWith(path.join(base, 'projects')), 'under the Claude config dir');
    assert.ok(doc.transcriptPath.endsWith(`${doc.harnessSessionId}.jsonl`), 'keyed by the native id');
    assert.ok(fs.existsSync(doc.transcriptPath), 'the derived path resolves to a real on-disk transcript');

    // patched to ended on graceful close (the real subprocess exits 0 after the one-shot turn)
    assert.equal(doc.state, 'ended');
    assert.equal(typeof doc.ext.endedAt, 'number');
  } finally {
    await cleanup();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('spawn-time spine write failure rejects the spawn and reaps the transport (no silent ghost)', { timeout: TIMEOUT_MS + 30_000 }, /** Verify spawn-time spine write failure rejects the spawn and reaps the transport (no silent ghost). */ async (t) => {
  // The `ses:` doc is the correlation spine — a failed spawn-time write must surface LOUDLY, not be
  // swallowed into an untracked ghost process. Isolate ONLY the db boundary (smallest fixture, §5): a
  // real `claude` subprocess opens, then `db.put` throws, and we assert (a) `run()` rejects with that
  // error and (b) the live transport was force-reaped (no leaked child).
  const bin = await assertClaudeBin(t);
  if (!bin) return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ses-cwd-'));
  const failingDb = { /** Implement put. */ async put() { throw new Error('boom: spine write rejected'); } };
  const harness = new Claude({ db: failingDb, config: { bin, cwd } });
  try {
    await assert.rejects(harness.run('Say exactly: hello sumo', { cwd }), /boom: spine write rejected/);
    // transport reaped by run()'s outer catch — `kill()` fires synchronously but the child's exit is
    // async, so poll until the real subprocess is actually gone (no leaked child) rather than race it.
    const pid = harness.transport.pid; // retained on the killed child until exit
    for (let i = 0; i < 100 && harness.transport.health.alive; i++) await settle();
    assert.equal(harness.transport.health.alive, false, 'transport reaped after the loud failure');
    if (pid != null) assert.throws(/** Run the callback. */ () => process.kill(pid, 0), /ESRCH/, 'no leaked subprocess');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('harness without db in ctx does not throw and writes no doc', { timeout: TIMEOUT_MS + 30_000 }, /** Verify harness without db in ctx does not throw and writes no doc. */ async (t) => {
  const { db, cleanup } = await openTempDb();
  let cwd;
  try {
    // No db in ctx → the writer is a no-op; the run must still complete against the real subprocess.
    const run = await runClaude({}, t);
    if (!run) return;
    ({ cwd } = run);
    const docs = await docsOf(db);
    assert.equal(docs.length, 0, 'no ses: docs written to the unrelated real db');
  } finally {
    await cleanup();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
});
