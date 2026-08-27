import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { sumoHome } from 'sumo/config';
import { open } from '../src/index.mjs';
import { securePath } from '../src/paths.mjs';
import { start } from '../src/daemon/host.mjs';

let home;
/** @type {import('../src/client.mjs').SumoDb} */
let db;

/** Implement waitFor. */ function waitFor(predicate, timeoutMs = 3000) {
  return new Promise(/** Run the callback. */ (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    /** Implement tick. */ function tick() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    }
    tick();
  });
}

before(/** Run the before hook. */ async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-client-'));
  db = await open({ home, idleShutdownMs: 1000 });
});

after(/** Run the after hook. */ async () => {
  await db.close();
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
  fs.rmSync(home, { recursive: true, force: true });
});

test('home directory is created mode 0700', /** Verify home directory is created mode 0700. */ () => {
  const mode = fs.statSync(home).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('sumoHome honors SUMO_HOME when present', /** Verify sumoHome honors SUMO_HOME when present. */ () => {
  const previous = process.env.SUMO_HOME;
  process.env.SUMO_HOME = home;
  try {
    assert.equal(sumoHome(), home);
    delete process.env.SUMO_HOME;
    assert.equal(sumoHome(), path.join(os.homedir(), '.sumo'));
  } finally {
    if (previous === undefined) delete process.env.SUMO_HOME;
    else process.env.SUMO_HOME = previous;
  }
});

test('daemon sockets and pidfile are owner-only mode 0600 (§12)', /** Verify daemon sockets and pidfile are owner-only mode 0600 (§12). */ () => {
  for (const f of ['sumo.sock', 'sumo-ctl.sock', 'sumo.pid']) {
    const mode = fs.statSync(path.join(home, f)).mode & 0o777;
    assert.equal(mode, 0o600, `${f} should be 0600, got ${mode.toString(8)}`);
  }
});

test('securePath surfaces chmod failures as Sumo errors', /** Verify securePath surfaces chmod failures as Sumo errors. */ () => {
  assert.throws(
    /** Run the callback. */ () => securePath(path.join(home, 'missing-secure-path')),
    /** Run the callback. */ (err) => err.code === 'SUMO_INSECURE_PERMS'
  );
});

test('KV put/get/del round-trips through the many-level transport', /** Verify KV put/get/del round-trips through the many-level transport. */ async () => {
  await db.put('ses:ses_1', { id: 'ses_1', state: 'working' });
  assert.deepEqual(await db.get('ses:ses_1'), { id: 'ses_1', state: 'working' });
  assert.equal(await db.get('ses:missing'), undefined);
  await db.del('ses:ses_1');
  assert.equal(await db.get('ses:ses_1'), undefined);
});

test('mergeDoc deep-merges a patch: patch wins per key, existing keys preserved', /** Verify mergeDoc deep-merges a patch: patch wins per key, existing keys preserved. */ async () => {
  await db.put('ses:ses_m', { id: 'ses_m', harness: 'claude-code', state: 'running', ext: { a: 1 } });
  await db.mergeDoc('ses:ses_m', { harnessSessionId: 'native-1', ext: { b: 2 } });
  assert.deepEqual(await db.get('ses:ses_m'), {
    id: 'ses_m', harness: 'claude-code', state: 'running', harnessSessionId: 'native-1', ext: { a: 1, b: 2 }
  });
  // patch wins per-key on conflict, untouched keys survive
  await db.mergeDoc('ses:ses_m', { state: 'ended', transcriptPath: '/p/x.jsonl' });
  const doc = await db.get('ses:ses_m');
  assert.equal(doc.state, 'ended');
  assert.equal(doc.transcriptPath, '/p/x.jsonl');
  assert.equal(doc.harnessSessionId, 'native-1', 'prior field not dropped');
});

test('mergeDoc on a missing key writes the patch as-is', /** Verify mergeDoc on a missing key writes the patch as-is. */ async () => {
  await db.mergeDoc('ses:ses_new', { id: 'ses_new', transcriptPath: '/p/y.jsonl' });
  assert.deepEqual(await db.get('ses:ses_new'), { id: 'ses_new', transcriptPath: '/p/y.jsonl' });
});

test('mergeDoc replaces arrays/scalars wholesale (no index-merge) and resists prototype pollution', /** Verify mergeDoc replaces arrays/scalars wholesale (no index-merge) and resists prototype pollution. */ async () => {
  await db.put('ses:ses_arr', { id: 'ses_arr', tags: ['a', 'b', 'c'], ext: { nested: { keep: 1 } } });
  // arrays REPLACE, not index-merge; nested plain objects still deep-merge with patch winning
  await db.mergeDoc('ses:ses_arr', { tags: ['x'], ext: { nested: { add: 2 } } });
  assert.deepEqual(await db.get('ses:ses_arr'), {
    id: 'ses_arr', tags: ['x'], ext: { nested: { keep: 1, add: 2 } }
  });
  // a crafted __proto__ key must not pollute Object.prototype
  await db.mergeDoc('ses:ses_arr', JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(({}).polluted, undefined, 'Object.prototype was not polluted');
});

test('mergeDoc preserves an existing TTL pointer (a merged key is not made immortal)', /** Verify mergeDoc preserves an existing TTL pointer (a merged key is not made immortal). */ async () => {
  await db.put('raw:ttltest', { v: 1 }, { ttlMs: 60_000 });
  await db.mergeDoc('raw:ttltest', { w: 2 });
  // the value merged, and a ttl pointer for the key still exists (retention preserved)
  const pointers = [];
  for await (const [, target] of db.scan('ttl:')) pointers.push(target);
  assert.ok(pointers.includes('raw:ttltest'), 'ttl pointer survived the merge');
});

test('concurrent mergeDoc to the same key never lost-updates (the harness ↔ agent-artifacts race)', /** Verify concurrent mergeDoc to the same key never lost-updates (the harness ↔ agent-artifacts race). */ async () => {
  await db.put('ses:ses_race', { id: 'ses_race', state: 'running', ext: {} });
  // Two independent writers patch disjoint fields at once — the daemon serializes both merges, so the
  // result must carry BOTH (a client read-modify-write would drop one).
  await Promise.all([
    db.mergeDoc('ses:ses_race', { harnessSessionId: 'native-2' }),       // harness writer
    db.mergeDoc('ses:ses_race', { transcriptPath: '/p/race.jsonl' })     // agent-artifacts writer
  ]);
  const doc = await db.get('ses:ses_race');
  assert.equal(doc.harnessSessionId, 'native-2', 'harness field survived');
  assert.equal(doc.transcriptPath, '/p/race.jsonl', 'agent-artifacts field survived');
  assert.equal(doc.state, 'running', 'untouched field intact');
});

test('scan returns ordered [key,value] pairs under a prefix', /** Verify scan returns ordered [key,value] pairs under a prefix. */ async () => {
  await db.put('txn:ses_2:0000000001', { i: 1 });
  await db.put('txn:ses_2:0000000002', { i: 2 });
  const out = [];
  for await (const [k, v] of db.scan('txn:ses_2:')) out.push([k, v.i]);
  assert.deepEqual(out, [['txn:ses_2:0000000001', 1], ['txn:ses_2:0000000002', 2]]);
});

test('append returns a seq; subscribe flushes backlog then streams live', /** Verify append returns a seq; subscribe flushes backlog then streams live. */ async () => {
  const s1 = await db.append({ dedupe: 'uuid:e1', type: 'session.message', payload: { text: 'hello' } });
  const s2 = await db.append({ dedupe: 'uuid:e2', type: 'session.message', payload: { text: 'world' } });
  assert.ok(s2 > s1);

  const received = [];
  const unsub = await db.subscribe({ since: 0 }, /** Run the callback. */ (e) => received.push(e));
  await waitFor(/** Run the callback. */ () => received.length >= 2); // backlog flush
  assert.deepEqual(received.map(/** Map one item. */ (e) => e.seq), [s1, s2]);

  // live delivery
  const s3 = await db.append({ dedupe: 'uuid:e3', type: 'session.message', payload: { text: 'live' } });
  await waitFor(/** Run the callback. */ () => received.some(/** Test whether an item matches. */ (e) => e.seq === s3));
  assert.equal(received.at(-1).payload.text, 'live');
  unsub();
});

test('subscribe re-delivers an enriched duplicate at its existing sequence', /** Verify enrichment updates are observable. */ async () => {
  const received = [];
  const unsub = await db.subscribe({ since: 0, filter: { type: ['session.tool'] } }, /** Run the callback. */ (event) => received.push(event));
  try {
    const seq = await db.append({ dedupe: 'enrichment-wakeup', type: 'session.tool', payload: { tool: { name: 'Read' } } });
    await waitFor(/** Run the callback. */ () => received.some(/** Test whether an item matches. */ (event) => event.seq === seq));
    await db.append({ dedupe: 'enrichment-wakeup', type: 'session.tool', payload: { tool: { output: 'contents' } } });
    await waitFor(/** Run the callback. */ () => received.some(/** Test whether an item matches. */ (event) => event.seq === seq && event.payload.tool.output === 'contents'));
    assert.equal(received.filter(/** Select matching items. */ (event) => event.seq === seq).length, 2);
  } finally {
    unsub();
  }
});

test('invalid append rejects instead of hanging', /** Verify invalid append rejects instead of hanging. */ async () => {
  await assert.rejects(
    db.append({ type: 'session.message' }),
    /** Run the callback. */ (err) => err.code === 'SUMO_BAD_MESSAGE'
  );
});

test('control requests reject when the daemon closes instead of remaining pending', /** Verify socket-close request cleanup. */ async () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-client-close-'));
  const daemon = await start({ home: isolatedHome, idleShutdownMs: 0 });
  const client = await open({ home: isolatedHome, autostart: false });
  try {
    await daemon.close();
    await assert.rejects(
      client.append({ dedupe: 'after-close', type: 'session.message' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_NO_DAEMON'
    );
  } finally {
    await client.close();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('daemon-side filtering only delivers matching event types', /** Verify daemon-side filtering only delivers matching event types. */ async () => {
  const got = [];
  const unsub = await db.subscribe({ since: 0, filter: { type: ['work.claimed'] } }, /** Run the callback. */ (e) => got.push(e));
  await db.append({ dedupe: 'uuid:noise', type: 'session.message', payload: { text: 'ignore' } });
  const target = await db.append({ dedupe: 'uuid:claim', type: 'work.claimed', payload: { workRef: 'w1' } });
  await waitFor(/** Run the callback. */ () => got.length >= 1);
  assert.equal(got.length, 1);
  assert.equal(got[0].seq, target);
  unsub();
});

test('search finds an appended event by payload text', /** Verify search finds an appended event by payload text. */ async () => {
  // append() resolves only after the daemon has indexed the event, so search is immediately ready
  await db.append({ dedupe: 'uuid:search', type: 'session.message', payload: { text: 'retry backoff strategy' } });
  const hits = await db.search('backoff');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].docref.startsWith('evt:'));
});

test('put with ttlMs writes a ttl pointer for the sweeper', /** Verify put with ttlMs writes a ttl pointer for the sweeper. */ async () => {
  await db.put('raw:ses_9:0000000001', { blob: 'x' }, { ttlMs: 60_000 });
  const pointers = [];
  for await (const [k, target] of db.scan('ttl:')) pointers.push([k, target]);
  assert.ok(pointers.some(/** Test whether an item matches. */ ([, target]) => target === 'raw:ses_9:0000000001'));
});
