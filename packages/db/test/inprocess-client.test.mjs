/**
 * Step 1b (spec 12): the in-process `SumoDb` facade a co-hosted runtime uses. It must behave like the
 * socket client (get/put/append/subscribe/scan) but NOT count toward `conns`, so idle-shutdown stays
 * governed by external clients only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { start } from '../src/daemon/host.mjs';

/** Implement sleep. */ function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }
/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ipc-')); }

/** Implement until. */ async function until(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for condition');
}

test('in-process facade does get/put/append/scan through the daemon-owned store', /** Verify in-process facade does get/put/append/scan through the daemon-owned store. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const ipc = daemon.inProcessClient();

  await ipc.put('kv:t:n:k', { v: 1 });
  assert.deepEqual(await ipc.get('kv:t:n:k'), { v: 1 });

  const seq = await ipc.append({ dedupe: 'uuid:a', type: 't', payload: { text: 'hi' } });
  assert.equal(seq, 1);

  const scanned = [];
  for await (const [k, v] of ipc.scan('kv:')) scanned.push([k, v]);
  assert.deepEqual(scanned, [['kv:t:n:k', { v: 1 }]]);

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('in-process subscribe sees backlog and live appends, woken by the same broadcast', /** Verify in-process subscribe sees backlog and live appends, woken by the same broadcast. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const ipc = daemon.inProcessClient();

  await ipc.append({ dedupe: 'uuid:b1', type: 't', payload: { n: 1 } }); // backlog

  const seen = [];
  const unsub = await ipc.subscribe({ since: 0 }, /** Run the callback. */ (e) => seen.push(e.seq));
  await until(/** Run the callback. */ () => seen.length >= 1); // backlog flushed

  await ipc.append({ dedupe: 'uuid:b2', type: 't', payload: { n: 2 } }); // live
  await until(/** Run the callback. */ () => seen.length >= 2);

  assert.deepEqual(seen.sort(/** Compare two items. */ (a, b) => a - b), [1, 2]);
  unsub();

  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle-shutdown still fires while only an in-process facade is active', /** Verify idle-shutdown still fires while only an in-process facade is active. */ async () => {
  const home = mkHome();
  let idleReason;
  const daemon = await start({ home, idleShutdownMs: 150 });
  daemon.onClose(/** Run the callback. */ (r) => { idleReason = r; });
  const ipc = daemon.inProcessClient();

  // Active in-process use + a live subscription — none of which is an external socket connection.
  await ipc.append({ dedupe: 'uuid:i1', type: 't' });
  const unsub = await ipc.subscribe({ since: 0 }, /** Run the callback. */ () => {});

  // With zero external clients, the daemon idle-exits despite the in-process facade being open.
  await until(/** Run the callback. */ () => idleReason === 'idle', 3000);
  assert.equal(idleReason, 'idle');
  unsub();

  fs.rmSync(home, { recursive: true, force: true });
});
