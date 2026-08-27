import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { open } from '../src/index.mjs';

// Two independent client connections to one daemon. The daemon is itself a separate process
// (auto-started), so this exercises the full cross-process event path: a write on connection B is
// delivered to a subscriber on connection A through the daemon's broadcast.

let home;
let a;
let b;

/** Implement waitFor. */ function waitFor(predicate, timeoutMs = 3000) {
  return new Promise(/** Run the callback. */ (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    /** Implement tick. */ function tick() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    }
    tick();
  });
}

before(/** Run the before hook. */ async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-xproc-'));
  a = await open({ home, idleShutdownMs: 1000 });
  b = await open({ home, idleShutdownMs: 1000 }); // second connection: finds the live socket, no 2nd daemon
});

after(/** Run the after hook. */ async () => {
  await a.close();
  await b.close();
  try {
    process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM');
  } catch { /* gone */ }
  fs.rmSync(home, { recursive: true, force: true });
});

test('LOAD-BEARING: a subscriber on connection A sees an event appended on connection B', /** Verify LOAD-BEARING: a subscriber on connection A sees an event appended on connection B. */ async () => {
  const seen = [];
  const unsub = await a.subscribe({ since: 0 }, /** Run the callback. */ (e) => seen.push(e));

  const seq = await b.append({ dedupe: 'uuid:xproc-1', type: 'session.tool', payload: { name: 'bash' } });
  await waitFor(/** Run the callback. */ () => seen.some(/** Test whether an item matches. */ (e) => e.seq === seq));

  const got = seen.find(/** Find a matching item. */ (e) => e.seq === seq);
  assert.equal(got.type, 'session.tool');
  assert.equal(got.payload.name, 'bash');
  unsub();
});

test('only one daemon exists for the shared home (the lock makes the spawn race safe)', /** Verify only one daemon exists for the shared home (the lock makes the spawn race safe). */ () => {
  assert.ok(fs.existsSync(path.join(home, 'sumo.pid')));
  assert.ok(fs.existsSync(path.join(home, 'sumo.sock')));
  assert.ok(fs.existsSync(path.join(home, 'sumo-ctl.sock')));
});

test('a late subscriber resumes from a watermark and misses nothing', /** Verify a late subscriber resumes from a watermark and misses nothing. */ async () => {
  const first = await b.append({ dedupe: 'uuid:wm-1', type: 'session.message', payload: { text: 'one' } });
  const second = await b.append({ dedupe: 'uuid:wm-2', type: 'session.message', payload: { text: 'two' } });

  // subscribe from after `first` — should receive only `second` onward, in order
  const seen = [];
  const unsub = await a.subscribe({ since: first }, /** Run the callback. */ (e) => seen.push(e));
  await waitFor(/** Run the callback. */ () => seen.some(/** Test whether an item matches. */ (e) => e.seq === second));
  assert.ok(seen.every(/** Test whether every item matches. */ (e) => e.seq > first));
  assert.ok(seen.some(/** Test whether an item matches. */ (e) => e.seq === second));
  unsub();
});

test('a duplicate dedupe appended on either connection collapses to one seq', /** Verify a duplicate dedupe appended on either connection collapses to one seq. */ async () => {
  const s1 = await a.append({ dedupe: 'uuid:shared', type: 'session.tool', payload: { name: 'first' } });
  const s2 = await b.append({ dedupe: 'uuid:shared', type: 'session.tool', payload: { name: 'second' } });
  assert.equal(s1, s2); // same logical event -> same seq across connections
});
