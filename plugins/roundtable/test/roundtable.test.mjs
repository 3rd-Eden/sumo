/**
 * roundtable plugin tests — real plugin runtime + injected isolated daemon (SUMO_INGEST=0).
 * Covers: presence, TTL, path identity, FCFS collision, tools round-trip, and boundary injection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { open } from 'sumo/db';
import { plugin, storage } from 'sumo/plugin';
import { createClaimRegistry } from '../claim.mjs';
import { extractFiles } from '../files.mjs';
import { appendMessage, persistRoom, readRoom, summarize } from '../room.mjs';

const REPO = '/work/test-repo';

process.env.SUMO_INGEST = '0';

/**
 * Spin up an isolated daemon + plugin runtime loaded with the roundtable plugin.
 * @param {object} [pluginConfig]
 */
async function setup(pluginConfig, { push } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-rt-test-'));
  const db = await open({ home, idleShutdownMs: 1000 });

  const rt = plugin({ cwd: REPO, db });
  if (push) rt.extendFacade('push', push);
  rt.sumo.use(roundtablePlugin, pluginConfig);
  await rt.start();

  return {
    rt,
    db,
    /** Implement teardown. */ async teardown() {
      await rt.stop();
      await db.close();
      try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

// Import roundtable inline (same process, no module resolution needed).
import roundtablePlugin from '../index.mjs';

/** Wait for N milliseconds (async event delivery from daemon to plugin runtime needs a beat). */
function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }

test('claim registry failures use the shared Result shape and keep claim metadata', /** Verify claim registry failures use the shared Result shape and keep claim metadata. */ () => {
  const registry = createClaimRegistry({ claimTtlMs: 1000 });
  assert.deepEqual(registry.acquire('/repo/a.mjs', 'ses_A'), { ok: true });

  const held = registry.acquire('/repo/a.mjs', 'ses_B');
  assert.equal(held.ok, false);
  assert.equal(held.code, 'SUMO_CLAIM_HELD');
  assert.match(held.reason, /ses_A/);
  assert.equal(held.holder, 'ses_A');
  assert.equal(typeof held.since, 'number');

  const all = registry.acquireAll(['/repo/b.mjs', '/repo/a.mjs'], 'ses_B');
  assert.equal(all.ok, false);
  assert.equal(all.code, 'SUMO_CLAIM_HELD');
  assert.equal(all.file, '/repo/a.mjs');
  assert.equal(all.holder, 'ses_A');
  assert.equal(registry.snapshot()['/repo/b.mjs'], undefined);
});

test('file extraction covers editor, multiedit and bash write paths', /** Verify file extraction covers editor, multiedit and bash write paths. */ () => {
  const root = REPO;
  assert.deepEqual(extractFiles({}, root), []);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'Read', input: { file_path: 'src/a.mjs' } } } }, root), []);

  assert.deepEqual(extractFiles({ payload: { tool: { name: 'Write', input: { file_path: 'src/a.mjs' } } } }, root), [
    path.resolve(root, 'src/a.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'Write', input: { file_path: 'src/default-root.mjs' } } } }), [
    path.resolve(process.cwd(), 'src/default-root.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'str_replace_editor', input: { path: 'src/b.mjs' } } } }, root), [
    path.resolve(root, 'src/b.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'NotebookEdit', input: {} } } }, root), []);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'MultiEdit', input: { edits: [{ file_path: 'src/c.mjs' }, { path: 'src/d.mjs' }, {}] } } } }, root), [
    path.resolve(root, 'src/c.mjs').toLowerCase(),
    path.resolve(root, 'src/d.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'MultiEdit', input: { edits: 'bad' } } } }, root), []);

  const bashFiles = extractFiles({ payload: { tool: { name: 'Bash', input: { command: 'mv src/a.mjs lib/a.mjs' } } } }, root);
  assert.deepEqual(bashFiles, [path.resolve(root, 'src/a.mjs').toLowerCase(), path.resolve(root, 'lib/a.mjs').toLowerCase()]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'bash', input: 'cp -f src/a.mjs dist/a.mjs' } } }, root), [
    path.resolve(root, 'dist/a.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'computer', input: { command: 'echo ok > out.txt' } } } }, root), [
    path.resolve(root, 'out.txt').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'run_terminal_cmd', input: { cmd: 'rm -f old.mjs tmp.mjs' } } } }, root), [
    path.resolve(root, 'old.mjs').toLowerCase(),
    path.resolve(root, 'tmp.mjs').toLowerCase()
  ]);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'Bash', input: {} } } }, root), []);
  assert.deepEqual(extractFiles({ payload: { tool: { name: 'Bash', input: { command: 42 } } } }, root), []);
});

test('room helpers use the real plugin store and summarize active conflicts', /** Verify room helpers use the real plugin store and summarize active conflicts. */ async () => {
  const { db, teardown } = await setup();
  try {
    const store = storage(db, 'roundtable-test', 'room');
    assert.deepEqual(await readRoom(store), { presence: {}, claims: {}, messages: [] });

    const messages = Array.from({ length: 52 }, /** Run the callback. */ (_, i) => ({ text: `m${i}`, ts: i })).reduce(/** Fold one item into the accumulator. */ (ring, msg) => appendMessage(ring, msg), []);
    assert.equal(messages.length, 50);
    assert.equal(messages[0].text, 'm2');

    await persistRoom(
      store,
      { ses_A: { cwd: REPO }, ses_B: { cwd: REPO } },
      { [path.join(REPO, 'src/a.mjs')]: { holder: 'ses_B' } },
      messages
    );
    const room = await readRoom(store);
    assert.equal(Object.keys(room.presence).length, 2);
    assert.match(summarize(room, 'ses_A'), /1 other agent active; 1 file conflict/);
    assert.equal(summarize({ presence: { ses_A: {} }, claims: {} }, 'ses_A'), null);
  } finally {
    await teardown();
  }
});

// Helper: append a session lifecycle event through the daemon → plugin runtime.
/** Implement emitEvent. */ async function emitEvent(db, type, payload, sessionId) {
  await db.append({
    dedupe: `test:${type}:${sessionId}:${Date.now()}:${Math.random()}`,
    type,
    source: 'session',
    adapter: 'codex',
    payload,
    ...(sessionId ? { sessionId } : {})
  });
  // Give the daemon → subscribe → queue → pump pipeline time to deliver.
  await sleep(50);
}

// Helper: drive a steer through the runtime.
/** Implement steer. */ async function steer(rt, action, payload, sessionId) {
  return rt.steer(action, { payload, can: {}, sessionId });
}

/** Implement waitForRoom. */ async function waitForRoom(rt, predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await rt.invoke('roundtable-room', {});
    if (last.ok && predicate(last.value)) return last.value;
    await sleep(10);
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

// Helper: register a session in presence so the plugin knows its cwd for path resolution.
/** Implement registerSession. */ async function registerSession(rt, db, sessionId, cwd, harness = 'claude-code') {
  await emitEvent(db, 'session.started', { harness, cwd, sessionId }, sessionId);
  await waitForRoom(rt, /** Run the callback. */ (room) => room.presence?.[sessionId]?.cwd === cwd, `session ${sessionId} registered`);
}

// ── Presence ────────────────────────────────────────────────────────────────────────────────────

test('presence: session.started adds to room, session.dead removes it', /** Verify presence: session.started adds to room, session.dead removes it. */ async () => {
  const { rt, db, teardown } = await setup({ enforce: false });
  try {
    // Wait for runtime to be ready for events.
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 50));

    await emitEvent(db, 'session.started', { harness: 'claude-code', cwd: REPO, sessionId: 'ses_A' }, 'ses_A');
    await emitEvent(db, 'session.started', { harness: 'cursor', cwd: REPO, sessionId: 'ses_B' }, 'ses_B');

    const room1 = await rt.invoke('roundtable-room', {});
    assert.ok(room1.ok);
    assert.ok(room1.value.presence['ses_A'], 'ses_A present');
    assert.ok(room1.value.presence['ses_B'], 'ses_B present');
    assert.equal(room1.value.agentCount, 2);

    await emitEvent(db, 'session.dead', { sessionId: 'ses_A' }, 'ses_A');

    const room2 = await rt.invoke('roundtable-room', {});
    assert.ok(!room2.value.presence['ses_A'], 'ses_A removed after dead');
    assert.ok(room2.value.presence['ses_B'], 'ses_B still present');
  } finally {
    await teardown();
  }
});

test('presence lifecycle accepts payload session ids and ignores unidentifiable lifecycle events', /** Verify presence lifecycle accepts payload session ids and ignores unidentifiable lifecycle events. */ async () => {
  const { rt, db, teardown } = await setup({ enforce: false });
  try {
    await sleep(50);

    await emitEvent(db, 'session.started', { harness: 'claude-code', cwd: REPO, sessionId: 'ses_PAYLOAD' }, undefined);
    await emitEvent(db, 'session.started', undefined, 'ses_TOP');
    await emitEvent(db, 'session.started', { harness: 'claude-code', cwd: REPO }, undefined);

    const room1 = await rt.invoke('roundtable-room', {});
    assert.ok(room1.ok);
    assert.ok(room1.value.presence.ses_PAYLOAD, 'payload sessionId registered presence');
    assert.ok(room1.value.presence.ses_TOP, 'top-level sessionId registered presence without payload');
    assert.equal(room1.value.agentCount, 2, 'unidentifiable session.started was ignored');

    await emitEvent(db, 'session.dead', { sessionId: 'ses_PAYLOAD' }, undefined);
    await emitEvent(db, 'session.ended', undefined, 'ses_TOP');
    await emitEvent(db, 'session.dead', {}, undefined);

    const room2 = await rt.invoke('roundtable-room', {});
    assert.ok(room2.ok);
    assert.equal(room2.value.presence.ses_PAYLOAD, undefined, 'payload sessionId removed presence');
    assert.equal(room2.value.presence.ses_TOP, undefined, 'top-level sessionId removed presence without payload');
    assert.equal(room2.value.agentCount, 0, 'unidentifiable session.dead was ignored');
  } finally {
    await teardown();
  }
});

// ── FCFS collision ───────────────────────────────────────────────────────────────────────────────

test('FCFS: first claim allowed, second denied with inject', /** Verify FCFS: first claim allowed, second denied with inject. */ async () => {
  const { rt, teardown } = await setup({ enforce: true });
  try {
    const file = path.join(REPO, 'src/auth.mjs');

    const r1 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_01');
    assert.ok(!('deny' in r1), 'first claimer allowed');

    const r2 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_02');
    assert.ok('deny' in r2, 'second claimer denied');
    assert.ok(r2.inject, 'inject message provided to second claimer');
    assert.ok(r2.inject.includes('roundtable'), 'inject references roundtable');
  } finally {
    await teardown();
  }
});

test('FCFS: same session re-entering its own claim is allowed', /** Verify FCFS: same session re-entering its own claim is allowed. */ async () => {
  const { rt, teardown } = await setup({ enforce: true });
  try {
    const file = path.join(REPO, 'src/db.mjs');
    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_A');
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_A');
    assert.ok(!('deny' in r), 're-entry by holder allowed');
  } finally {
    await teardown();
  }
});

test('FCFS: enforce:false warns but allows', /** Verify FCFS: enforce:false warns but allows. */ async () => {
  const { rt, teardown } = await setup({ enforce: false });
  try {
    const file = path.join(REPO, 'src/x.mjs');
    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_A');
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_B');
    assert.ok(!('deny' in r), 'warn-only mode allows the write');
    assert.ok(r.inject, 'inject message still present');
  } finally {
    await teardown();
  }
});

test('FCFS: non-write tools pass and unextractable writes warn only when peers are active', /** Verify FCFS: non-write tools pass and unextractable writes warn only when peers are active. */ async () => {
  const { rt, db, teardown } = await setup({ enforce: true });
  try {
    await registerSession(rt, db, 'ses_A', REPO);
    await registerSession(rt, db, 'ses_B', REPO);

    const readOnly = await steer(rt, 'tool', { tool: { name: 'Read', input: { file_path: 'src/a.mjs' } } }, 'ses_A');
    assert.ok(!('deny' in readOnly));
    assert.equal(readOnly.inject, undefined);

    const unknown = await steer(rt, 'tool', { tool: { name: 'ProjectSearch', input: { query: 'sumo' } } }, 'ses_A');
    assert.ok(!('deny' in unknown));
    assert.equal(unknown.inject, undefined);

    const writeWithoutTargets = await steer(rt, 'tool', { tool: { name: 'Bash', input: { command: 'npm test' } } }, 'ses_A');
    assert.ok(!('deny' in writeWithoutTargets));
    assert.match(writeWithoutTargets.inject, /could not be extracted/);

    await emitEvent(db, 'session.dead', { sessionId: 'ses_B' }, 'ses_B');
    await sleep(50);

    const soloWriteWithoutTargets = await steer(rt, 'tool', { tool: { name: 'Bash', input: { command: 'npm test' } } }, 'ses_A');
    assert.ok(!('deny' in soloWriteWithoutTargets));
    assert.equal(soloWriteWithoutTargets.inject, undefined);
  } finally {
    await teardown();
  }
});

// ── Path identity ────────────────────────────────────────────────────────────────────────────────

test('path identity: relative and absolute of same file collide on one claim', /** Verify path identity: relative and absolute of same file collide on one claim. */ async () => {
  const { rt, db, teardown } = await setup({ enforce: true });
  try {
    // Sessions must be in presence so the plugin knows their cwd for relative-path resolution.
    await registerSession(rt, db, 'ses_A', REPO);
    await registerSession(rt, db, 'ses_B', REPO);

    const abs = path.join(REPO, 'src/router.mjs');
    const rel = 'src/router.mjs'; // resolves to abs when session cwd == REPO

    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: abs } } }, 'ses_A');
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: rel } } }, 'ses_B');
    assert.ok('deny' in r, 'relative path collides with absolute claim');
  } finally {
    await teardown();
  }
});

test('path identity: same basename in different directories does NOT collide', /** Verify path identity: same basename in different directories does NOT collide. */ async () => {
  const { rt, teardown } = await setup({ enforce: true });
  try {
    const fileA = path.join(REPO, 'src/util.mjs');
    const fileB = path.join(REPO, 'lib/util.mjs');

    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: fileA } } }, 'ses_A');
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: fileB } } }, 'ses_B');
    assert.ok(!('deny' in r), 'different-dir same-basename files are independent');
  } finally {
    await teardown();
  }
});

test('path identity: multi-file all-or-nothing — if any held, partials are released', /** Verify path identity: multi-file all-or-nothing — if any held, partials are released. */ async () => {
  const { rt, teardown } = await setup({ enforce: true });
  try {
    const fileA = path.join(REPO, 'src/a.mjs');
    const fileB = path.join(REPO, 'src/b.mjs');
    const fileC = path.join(REPO, 'src/c.mjs');

    // ses_A claims fileB
    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: fileB } } }, 'ses_A');

    // ses_B tries MultiEdit [a, b, c] — should fail on b and release a (not leave partial claim)
    const r = await steer(rt, 'tool', {
      tool: { name: 'MultiEdit', input: { edits: [{ file_path: fileA }, { file_path: fileB }, { file_path: fileC }] } }
    }, 'ses_B');
    assert.ok('deny' in r, 'multi-file denied when any held');

    // ses_C should be able to claim fileA (proves ses_B's partial was released)
    const r2 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: fileA } } }, 'ses_C');
    assert.ok(!('deny' in r2), 'fileA available after partial rollback');
  } finally {
    await teardown();
  }
});

// ── Tools round-trip ─────────────────────────────────────────────────────────────────────────────

test('roundtable-announce then roundtable-room round-trips the message', /** Verify roundtable-announce then roundtable-room round-trips the message. */ async () => {
  const { rt, teardown } = await setup();
  try {
    const announce = await rt.invoke('roundtable-announce', { message: 'Working on auth refactor', intent: 'refactor' });
    assert.ok(announce.ok);
    assert.ok(announce.value.ts > 0);

    const room = await rt.invoke('roundtable-room', {});
    assert.ok(room.ok);
    const found = room.value.messages.find(/** Find a matching item. */ (m) => m.text === 'Working on auth refactor');
    assert.ok(found, 'announcement found in room messages');
    assert.equal(found.intent, 'refactor');

    const withoutIntent = await rt.invoke('roundtable-announce', { message: 'Status only' });
    assert.ok(withoutIntent.ok);
    const updated = await rt.invoke('roundtable-room', {});
    const statusOnly = updated.value.messages.find(/** Find a matching item. */ (m) => m.text === 'Status only');
    assert.ok(statusOnly, 'announcement without intent found in room messages');
    assert.equal(statusOnly.intent, undefined);
  } finally {
    await teardown();
  }
});

test('roundtable-announce persists files, intent, session id, and emits session-scoped event', /** Verify roundtable-announce persists files, intent, session id, and emits session-scoped event. */ async () => {
  const { rt, db, teardown } = await setup();
  try {
    const announce = await rt.invoke('roundtable-announce', {
      message: 'Touching parser fixtures',
      files: ['packages/transcript/test/fixtures/codex/stream/tool.jsonl'],
      intent: 'verify',
      sessionId: 'ses_ANN'
    });
    assert.ok(announce.ok);

    const room = await rt.invoke('roundtable-room', {});
    const found = room.value.messages.find(/** Find a matching item. */ (m) => m.text === 'Touching parser fixtures');
    assert.deepEqual(found.files, ['packages/transcript/test/fixtures/codex/stream/tool.jsonl']);
    assert.equal(found.intent, 'verify');
    assert.equal(found.sessionId, 'ses_ANN');

    const emitted = [];
    for await (const [, event] of db.scan('evt:')) {
      if (event.type === 'roundtable.announce' && event.payload?.text === 'Touching parser fixtures') emitted.push(event);
    }
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].sessionId, 'ses_ANN');
  } finally {
    await teardown();
  }
});

test('roundtable-room appears in the runtime capability catalog', /** Verify roundtable-room appears in the runtime capability catalog. */ async () => {
  const { rt, teardown } = await setup();
  try {
    const caps = rt.capabilities();
    const names = caps.map(/** Map one item. */ (c) => c.name);
    assert.ok(names.includes('roundtable-room'), 'roundtable-room in catalog');
    assert.ok(names.includes('roundtable-announce'), 'roundtable-announce in catalog');
    // Both must declare mcp surface
    const roomCap = caps.find(/** Find a matching item. */ (c) => c.name === 'roundtable-room');
    assert.ok(roomCap.surfaces.includes('mcp'));
  } finally {
    await teardown();
  }
});

test('boundary injection reports room changes once in changed-only mode and every time in always mode', /** Verify boundary injection reports room changes once in changed-only mode and every time in always mode. */ async () => {
  const changed = await setup({ boundaryLine: 'changed-only' });
  try {
    await registerSession(changed.rt, changed.db, 'ses_A', REPO);
    await registerSession(changed.rt, changed.db, 'ses_B', REPO);

    const first = await steer(changed.rt, 'prompt', {}, 'ses_A');
    assert.match(first.inject, /1 other agent active/);
    const second = await steer(changed.rt, 'prompt', {}, 'ses_A');
    assert.equal(second.inject, undefined);

    await emitEvent(changed.db, 'session.ended', { sessionId: 'ses_B' }, 'ses_B');
    await sleep(50);
    const afterLeave = await steer(changed.rt, 'prompt', {}, 'ses_A');
    assert.equal(afterLeave.inject, undefined, 'solo session has nothing to report');
  } finally {
    await changed.teardown();
  }

  const always = await setup({ boundaryLine: 'always' });
  try {
    await registerSession(always.rt, always.db, 'ses_A', REPO);
    await registerSession(always.rt, always.db, 'ses_B', REPO);

    const first = await steer(always.rt, 'prompt', {}, 'ses_A');
    const second = await steer(always.rt, 'prompt', {}, 'ses_A');
    assert.match(first.inject, /1 other agent active/);
    assert.match(second.inject, /1 other agent active/);
  } finally {
    await always.teardown();
  }
});

// ── No session identity → graceful degrade ───────────────────────────────────────────────────────

test('before tool with no sessionId is allowed (degrade gracefully)', /** Verify before tool with no sessionId is allowed (degrade gracefully). */ async () => {
  const { rt, teardown } = await setup({ enforce: true });
  try {
    const file = path.join(REPO, 'src/noid.mjs');
    // sessionId = undefined
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, undefined);
    assert.ok(!('deny' in r), 'no identity → allowed (safe degrade)');
    const prompt = await steer(rt, 'prompt', {}, undefined);
    assert.equal(prompt.inject, undefined, 'no identity → no boundary injection');
  } finally {
    await teardown();
  }
});

// ── TTL ageout without session.dead ─────────────────────────────────────────────────────────────

test('session ages out of presence after claimTtlMs of silence (no session.dead)', /** Verify session ages out of presence after claimTtlMs of silence (no session.dead). */ async () => {
  // A session that goes silent (no events) must be evicted by the TTL reaper, not only on explicit
  // session.dead. This proves the liveness backstop works without depending on death events.
  const { rt, db, teardown } = await setup({ claimTtlMs: 200, graceMs: 50 });
  try {
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 50));

    // Session starts
    await emitEvent(db, 'session.started', { harness: 'claude-code', cwd: REPO, sessionId: 'ses_TTL' }, 'ses_TTL');

    const room1 = await rt.invoke('roundtable-room', {});
    assert.ok(room1.value.presence['ses_TTL'], 'session present initially');

    // ses_TTL claims a file
    const file = path.join(REPO, 'src/ttl-test.mjs');
    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_TTL');

    const room2 = await rt.invoke('roundtable-room', {});
    assert.ok(room2.value.claims[path.resolve(REPO, file)] || Object.keys(room2.value.claims).length > 0,
      'claim present after steer');

    // Wait for TTL + reaper + grace to expire without any activity
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 400));

    // Another session should now be able to claim the file (TTL-expired = released)
    const r = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_OTHER');
    assert.ok(!('deny' in r), 'file available after TTL expiry of silent holder');
  } finally {
    await teardown();
  }
});

test('claim without presence is confirmed expired and fully released by the TTL reaper', /** Verify claim without presence is confirmed expired and fully released by the TTL reaper. */ async () => {
  const { rt, teardown } = await setup({ claimTtlMs: 80, graceMs: 20 });
  try {
    const file = path.join(REPO, 'src/no-presence-ttl.mjs');
    const first = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_ORPHAN');
    assert.ok(!('deny' in first));

    const held = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_OTHER');
    assert.ok('deny' in held, 'claim exists before TTL expiry');

    await sleep(250);

    const afterTtl = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_OTHER');
    assert.ok(!('deny' in afterTtl), 'orphan claim released after confirmed expiry');
  } finally {
    await teardown();
  }
});

test('destroy clears outstanding grace probe timers', /** Verify destroy clears outstanding grace probe timers. */ async () => {
  let pushes = 0;
  const { rt, db, teardown } = await setup(
    { claimTtlMs: 80, graceMs: 250 },
    { /** Implement push. */ async push() { pushes++; return { ok: true }; } }
  );
  try {
    await sleep(50);
    await registerSession(rt, db, 'ses_PROBE', REPO);
    const file = path.join(REPO, 'src/probe-test.mjs');
    await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_PROBE');

    const deadline = Date.now() + 500;
    while (pushes === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(pushes, 1, 'reaper started a liveness probe');

    const roomKey = 'kv:roundtable:room:state';
    const roomDeadline = Date.now() + 500;
    let roomBefore;
    while (Date.now() < roomDeadline) {
      roomBefore = await db.get(roomKey);
      if (roomBefore?.claims?.[file]) break;
      await sleep(20);
    }
    assert.ok(roomBefore?.claims?.[file], 'claim was persisted before shutdown');

    await rt.stop();
    await sleep(300);
    assert.deepEqual(await db.get(roomKey), roomBefore, 'cleared grace timer did not write an expiry after destroy');
  } finally {
    await teardown();
  }
});

// ── Idle-eviction does not drop live claims ──────────────────────────────────────────────────────

test('destroy() releases this runtimes sessions but an idle-eviction does not wipe untracked claims', /** Verify destroy() releases this runtimes sessions but an idle-eviction does not wipe untracked claims. */ async () => {
  // The claim registry is in-process. When destroy() is called (on eviction), it releases only
  // the sessions tracked by THIS runtime's presence map. It must NOT call a blanket registry clear.
  const { rt, db, teardown } = await setup({ enforce: true });
  try {
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 50));

    await emitEvent(db, 'session.started', { harness: 'claude-code', cwd: REPO, sessionId: 'ses_EVICT' }, 'ses_EVICT');

    const file = path.join(REPO, 'src/evict-test.mjs');
    // ses_EVICT claims the file
    const r1 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_EVICT');
    assert.ok(!('deny' in r1), 'ses_EVICT acquired claim');

    // ses_OTHER also tries to claim — should be denied since ses_EVICT holds it
    const r2 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_OTHER');
    assert.ok('deny' in r2, 'ses_OTHER denied (ses_EVICT holds the file)');

    // Explicitly release ses_EVICT via session.dead (simulates what destroy does for tracked sessions)
    await emitEvent(db, 'session.dead', { sessionId: 'ses_EVICT' }, 'ses_EVICT');
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 100));

    // Now ses_OTHER should be able to claim
    const r3 = await steer(rt, 'tool', { tool: { name: 'Edit', input: { file_path: file } } }, 'ses_OTHER');
    assert.ok(!('deny' in r3), 'ses_OTHER can claim after ses_EVICT released');
  } finally {
    await teardown();
  }
});
