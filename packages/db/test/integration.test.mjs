import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { open } from '../src/index.mjs';
import { evtKey } from '../src/keyspace.mjs';
import { paths } from '../src/paths.mjs';

// Every test here runs against a REAL daemon: real classic-level, real unix sockets, real detached
// child process. No fakes, no mocks — if these pass, the deployed path works.

/** Implement sleep. */ function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }
/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-int-')); }

/** Implement until. */ async function until(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for condition');
}

/** Implement killByPid. */ function killByPid(home) {
  try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
}

test('TTL sweeper (real daemon) deletes an expired record and emits ttl.swept', /** Verify TTL sweeper (real daemon) deletes an expired record and emits ttl.swept. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000, sweepIntervalMs: 40 });
  try {
    const swept = [];
    await db.subscribe({ since: 0, filter: { type: ['ttl.swept'] } }, /** Run the callback. */ (e) => swept.push(e));

    await db.put('raw:ses_ttl:0000000001', { blob: 'secret' }, { ttlMs: 1000 });
    assert.deepEqual(await db.get('raw:ses_ttl:0000000001'), { blob: 'secret' });

    // the real interval sweeper picks it up and removes it
    await until(/** Run the callback. */ async () => (await db.get('raw:ses_ttl:0000000001')) === undefined);
    await until(/** Run the callback. */ () => swept.length >= 1);
    assert.equal(swept[0].type, 'ttl.swept');
    assert.ok(swept[0].payload.count >= 1);
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('TTL sweeper does not delete a newer replacement for an expired key', /** Verify TTL sweeper does not delete a newer replacement for an expired key. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000, sweepIntervalMs: 20 });
  try {
    await db.put('raw:ses_reuse:0000000001', { blob: 'old' }, { ttlMs: 20 });
    await db.del('raw:ses_reuse:0000000001');
    await db.put('raw:ses_reuse:0000000001', { blob: 'new' });
    await sleep(100);
    assert.deepEqual(await db.get('raw:ses_reuse:0000000001'), { blob: 'new' });
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('raw records are redacted before persistence', /** Verify raw records are redacted before persistence. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  try {
    await db.put('raw:ses_redact:0000000001', {
      authorization: 'Bearer abcdefghijklmnop',
      command: 'OPENAI_API_KEY=sk-abcdefghijklmnop node task.mjs'
    });
    const stored = await db.get('raw:ses_redact:0000000001');
    assert.deepEqual(stored, {
      authorization: '[REDACTED:secret]',
      command: 'OPENAI_API_KEY=[REDACTED:secret] node task.mjs'
    });
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('explicit storage and socket paths survive daemon autostart', /** Verify config-plumbed daemon paths. */ async () => {
  const home = mkHome();
  const storagePath = path.join(home, 'project-db');
  const socket = path.join(home, 'project.sock');
  const db = await open({ home, dbPath: storagePath, socket, idleShutdownMs: 5000 });
  try {
    await db.put('kv:config:path', { ok: true });
    assert.deepEqual(await db.get('kv:config:path'), { ok: true });
    assert.ok(fs.existsSync(storagePath));
    assert.ok(fs.existsSync(socket));
    assert.ok(fs.existsSync(`${socket.slice(0, -'.sock'.length)}-ctl.sock`));
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('parser native evidence is redacted behind rawRef and never stored in event ext', /** Verify daemon append enforces the native raw boundary. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  try {
    const seq = await db.append({
      dedupe: 'raw-boundary:1', type: 'session.raw:stdout', source: 'session', payload: {},
      ext: { native: { line: 'Authorization: Bearer sk-livesecret0123456789' }, harmless: true }
    });
    const stored = await db.get(evtKey(seq));
    assert.deepEqual(stored.ext, { harmless: true });
    assert.equal(stored.rawRef, 'raw:event:raw-boundary:1');
    const raw = await db.get(stored.rawRef);
    assert.match(JSON.stringify(raw), /REDACTED/);
    assert.doesNotMatch(JSON.stringify(raw), /livesecret/);
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dedup enrichment (real daemon) merges a richer duplicate into the stored event', /** Verify dedup enrichment (real daemon) merges a richer duplicate into the stored event. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  try {
    const seq1 = await db.append({
      dedupe: 'uuid:enrich', type: 'session.tool', ts: 100,
      payload: { name: 'bash' }, ext: { live: { streamed: true } }
    });
    const seq2 = await db.append({
      dedupe: 'uuid:enrich', type: 'session.tool', ts: 999,
      payload: { name: 'IGNORED', output: 'done' }, sessionId: 'ses_e',
      ext: { transcript: { parentUuid: 'p1' } }
    });
    assert.equal(seq2, seq1); // collapsed

    // read the stored envelope straight from the store through the client
    const stored = await db.get(evtKey(seq1));
    assert.equal(stored.ts, 100); // first-writer wins
    assert.equal(stored.payload.name, 'bash'); // present -> not overwritten
    assert.equal(stored.payload.output, 'done'); // gap -> filled from richer source
    assert.equal(stored.sessionId, 'ses_e'); // gap -> filled
    assert.deepEqual(stored.ext, { live: { streamed: true }, transcript: { parentUuid: 'p1' } });
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dedup enrichment updates the live search index', /** Verify dedup enrichment updates the live search index. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  try {
    await db.append({ dedupe: 'uuid:search-enrich', type: 'session.message', payload: { text: 'alpha' } });
    assert.deepEqual(await db.search('needle'), []);

    await db.append({
      dedupe: 'uuid:search-enrich',
      type: 'session.message',
      payload: { text: 'alpha', output: 'needle' }
    });
    const hits = await db.search('needle');
    assert.equal(hits.length, 1);
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('control channel pushes a wake-up signal (seq), never the event payload', /** Verify control channel pushes a wake-up signal (seq), never the event payload. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  // raw control connection, bypassing the client, to inspect the actual wire format
  const ctl = net.connect(paths(home).ctlSock);
  await new Promise(/** Run the callback. */ (resolve, reject) => { ctl.once('connect', resolve); ctl.once('error', reject); });
  const lines = [];
  readline.createInterface({ input: ctl }).on('line', /** Run the callback. */ (l) => lines.push(JSON.parse(l)));
  try {
    ctl.write(JSON.stringify({ id: 's1', op: 'subscribe', since: 0 }) + '\n');
    await until(/** Run the callback. */ () => lines.some(/** Test whether an item matches. */ (m) => m.id === 's1' && m.ok)); // subscribe ack

    const seq = await db.append({ dedupe: 'uuid:wake', type: 'session.message', payload: { text: 'secret-body' } });
    await until(/** Run the callback. */ () => lines.some(/** Test whether an item matches. */ (m) => m.sub === 's1'));

    const wake = lines.find(/** Find a matching item. */ (m) => m.sub === 's1');
    assert.equal(wake.seq, seq, 'wake-up carries the new seq');
    assert.equal(wake.event, undefined, 'wake-up is a signal, not a payload');
    assert.ok(!JSON.stringify(wake).includes('secret-body'), 'payload text never crosses the wire as a push');
  } finally {
    ctl.destroy();
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('search index is rebuilt from the log when the daemon restarts', /** Verify search index is rebuilt from the log when the daemon restarts. */ async () => {
  const home = mkHome();
  let db = await open({ home, idleShutdownMs: 10_000 });
  await db.append({ dedupe: 'uuid:idx', type: 'session.message', payload: { text: 'distinctive haystack token' } });
  await db.close();

  // hard-kill: the in-memory minisearch index dies with the process
  const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await until(/** Run the callback. */ () => { try { process.kill(pid, 0); return false; } catch { return true; } });

  // a fresh daemon must rebuild the index from evt: on startup
  db = await open({ home, idleShutdownMs: 10_000 });
  try {
    const hits = await db.search('haystack');
    assert.ok(hits.length >= 1, 'rebuilt index should find the pre-restart event');
    assert.ok(hits[0].docref.startsWith('evt:'));
  } finally {
    await db.close();
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
