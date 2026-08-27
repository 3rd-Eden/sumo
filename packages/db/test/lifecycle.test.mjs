import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { open } from '../src/index.mjs';
import { start } from '../src/daemon/host.mjs';
import { paths } from '../src/paths.mjs';

/** Implement sleep. */ function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }
/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-life-')); }

/** Implement until. */ async function until(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for condition');
}

/** Implement probe. */ function probe(sock) {
  return new Promise(/** Run the callback. */ (resolve) => {
    const s = net.connect(sock);
    s.once('connect', /** Run the callback. */ () => { s.destroy(); resolve(true); });
    s.once('error', /** Run the callback. */ () => { s.destroy(); resolve(false); });
  });
}

/** Implement killByPid. */ function killByPid(home) {
  try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
}

test('autostart spawns a detached daemon and idle-shutdown stops it when idle', /** Verify autostart spawns a detached daemon and idle-shutdown stops it when idle. */ async () => {
  const home = mkHome();
  const p = paths(home);
  const db = await open({ home, idleShutdownMs: 200 });
  await db.append({ dedupe: 'uuid:idle', type: 't' });
  await db.close();
  // with zero clients the daemon idle-exits, cleaning up its pidfile
  await until(/** Run the callback. */ () => !fs.existsSync(p.pid));
  assert.equal(await probe(p.kvSock), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('autostart:false yields SUMO_NO_DAEMON instead of spawning', /** Verify autostart:false yields SUMO_NO_DAEMON instead of spawning. */ async () => {
  const home = mkHome();
  await assert.rejects(
    open({ home, autostart: false }),
    /** Run the callback. */ (err) => err.code === 'SUMO_NO_DAEMON'
  );
  assert.equal(fs.existsSync(paths(home).pid), false); // nothing was spawned
  fs.rmSync(home, { recursive: true, force: true });
});

test('shutdown stops the daemon gracefully and a later open restarts it', /** Verify public shutdown closes sockets and preserves restartability. */ async () => {
  const home = mkHome();
  const p = paths(home);
  let db = await open({ home, idleShutdownMs: 10_000 });
  const first = await db.append({ dedupe: 'uuid:shutdown-1', type: 't', payload: { text: 'before' } });
  await db.shutdown();
  await db.close();

  await until(/** Run the callback. */ async () => !(await probe(p.kvSock)) && !fs.existsSync(p.pid));
  await assert.rejects(open({ home, autostart: false }), /** Run the callback. */ (err) => err.code === 'SUMO_NO_DAEMON');

  db = await open({ home, idleShutdownMs: 10_000 });
  const second = await db.append({ dedupe: 'uuid:shutdown-2', type: 't', payload: { text: 'after' } });
  assert.equal(second, first + 1);
  await db.close();
  killByPid(home);
  fs.rmSync(home, { recursive: true, force: true });
});

test('SUMO_NO_AUTOSTART=1 env var also disables autostart', /** Verify SUMO_NO_AUTOSTART=1 env var also disables autostart. */ async () => {
  const home = mkHome();
  const prev = process.env.SUMO_NO_AUTOSTART;
  process.env.SUMO_NO_AUTOSTART = '1';
  try {
    await assert.rejects(open({ home }), /** Run the callback. */ (err) => err.code === 'SUMO_NO_DAEMON');
    assert.equal(fs.existsSync(paths(home).pid), false);
  } finally {
    if (prev === undefined) delete process.env.SUMO_NO_AUTOSTART;
    else process.env.SUMO_NO_AUTOSTART = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a second daemon on the same store fails fast with SUMO_DB_LOCKED', /** Verify a second daemon on the same store fails fast with SUMO_DB_LOCKED. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 }); // first daemon owns the lock
  await assert.rejects(
    start({ home }),
    /** Run the callback. */ (err) => err.code === 'SUMO_DB_LOCKED'
  );
  await db.close();
  killByPid(home);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash recovery: after a hard kill, a new daemon recovers seq and loses no events', /** Verify crash recovery: after a hard kill, a new daemon recovers seq and loses no events. */ async () => {
  const home = mkHome();
  let db = await open({ home, idleShutdownMs: 10_000 });
  const s1 = await db.append({ dedupe: 'uuid:c1', type: 't', payload: { text: 'one' } });
  const s2 = await db.append({ dedupe: 'uuid:c2', type: 't', payload: { text: 'two' } });
  await db.close();

  // hard-kill the daemon (no graceful cleanup): stale socket/pid files remain
  const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await until(/** Run the callback. */ () => { try { process.kill(pid, 0); return false; } catch { return true; } });

  // reopen: the OS released the LevelDB lock, a new daemon starts, unlinks stale sockets, recovers
  db = await open({ home, idleShutdownMs: 10_000 });
  const s3 = await db.append({ dedupe: 'uuid:c3', type: 't', payload: { text: 'three' } });
  assert.equal(s3, s2 + 1); // seq continued from the recovered watermark

  const seen = [];
  const unsub = await db.subscribe({ since: 0 }, /** Run the callback. */ (e) => seen.push(e));
  await until(/** Run the callback. */ async () => seen.length >= 3);
  assert.deepEqual(seen.map(/** Map one item. */ (e) => e.seq).sort(/** Compare two items. */ (a, b) => a - b), [s1, s2, s3]);
  unsub();

  await db.close();
  killByPid(home);
  fs.rmSync(home, { recursive: true, force: true });
});
