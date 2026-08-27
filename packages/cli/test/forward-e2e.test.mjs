/**
 * Step 3 (spec 12) proof gate: a REAL captured Claude PreToolUse payload, fed through `sumo forward`'s
 * command (`forward`) against the co-hosted daemon, yields the correct native allow/deny on stdout.
 * Also measures the warm round-trip latency against the Claude hook-timeout headroom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { open, key } from 'sumo/db';
import { start as startStorageDaemon } from 'sumo/db/daemon';
import { startSteeringDaemon } from '../src/daemon-host.mjs';
import { forward } from '../src/index.mjs';

const FIX = path.join(fileURLToPath(new URL('../../harness/test/fixtures/hook', import.meta.url)));
const preToolUse = fs.readFileSync(path.join(FIX, 'claude-code/PreToolUse.json'), 'utf8');
const codexPostToolUse = fs.readFileSync(path.join(FIX, 'codex/PostToolUse.json'), 'utf8');
const cursorAfterShellExecution = fs.readFileSync(path.join(FIX, 'cursor/afterShellExecution.json'), 'utf8');
/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-fwd-home-')); }

/** Implement eventsOf. */ async function eventsOf(db, type) {
  const events = [];
  for await (const [, event] of db.scan('evt:')) {
    if (event.type === type) events.push(event);
  }
  return events;
}

/** Implement mkProject. */ function mkProject(name, pluginBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sumo-fwd-${name}-`));
  fs.writeFileSync(path.join(dir, 'sumo.yml'), "root: true\nuse:\n  - './plugin.mjs'\n");
  fs.writeFileSync(path.join(dir, 'plugin.mjs'), `export default function gate(sumo) {\n  sumo.before('tool', ${pluginBody});\n}\n`);
  return dir;
}

test('forward PreToolUse: a deny plugin → Claude permissionDecision:deny on stdout', /** Verify forward PreToolUse: a deny plugin → Claude permissionDecision:deny on stdout. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = mkProject('deny', "(e) => (e.payload.tool.name === 'Bash' ? { deny: 'no bash here' } : undefined)");

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  const written = [];
  const code = await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: preToolUse, cwd: proj, db, /** Implement out. */ out(s) { return written.push(s); } });

  assert.equal(code, 0);
  const native = JSON.parse(written.join(''));
  assert.equal(native.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(native.hookSpecificOutput.permissionDecisionReason, /no bash here/);

  const observed = (await eventsOf(db, 'session.tool')).find(/** Find a matching item. */ (event) => event.source === 'hook' && event.adapter === 'claude-code');
  assert.ok(observed, 'PreToolUse was also forwarded into the daemon event log');
  assert.equal(observed.payload.tool.name, 'Bash');
  assert.equal(observed.rawRef.startsWith(`raw:hook:${observed.sessionId}:`), true);
  assert.equal(JSON.parse(await db.get(observed.rawRef)).tool_name, 'Bash');

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});

test('forward PreToolUse: an allow plugin → empty stdout (no interference)', /** Verify forward PreToolUse: an allow plugin → empty stdout (no interference). */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = mkProject('allow', '() => undefined'); // pass through

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  const written = [];
  const code = await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: preToolUse, cwd: proj, db, /** Implement out. */ out(s) { return written.push(s); } });
  assert.equal(code, 0);
  assert.equal(written.join(''), '');

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});

test('forward observation-only hooks append through the real daemon without calling steer', /** Verify forward observation-only hooks append through the real daemon without calling steer. */ async () => {
  const home = mkHome();
  const daemon = await startStorageDaemon({ home, idleShutdownMs: 0 });
  const db = await open({ home, autostart: false });

  const written = [];
  const code = await forward({ harness: 'codex', nativeEvent: 'PostToolUse', payloadText: codexPostToolUse, cwd: '/unused', db, /** Implement out. */ out(s) { return written.push(s); } });
  assert.equal(code, 0);
  assert.equal(written.join(''), '');

  const observed = (await eventsOf(db, 'session.tool')).find(/** Find a matching item. */ (event) => event.source === 'hook' && event.adapter === 'codex');
  assert.ok(observed);
  assert.equal(observed.payload.tool.name, 'Bash');
  assert.equal(JSON.parse(await db.get(observed.rawRef)).tool_name, 'Bash');

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('forward cursor afterShellExecution appends the normalized shell observation through the real daemon', /** Verify forward cursor afterShellExecution appends the normalized shell observation through the real daemon. */ async () => {
  const home = mkHome();
  const daemon = await startStorageDaemon({ home, idleShutdownMs: 0 });
  const db = await open({ home, autostart: false });

  const written = [];
  const code = await forward({ harness: 'cursor', nativeEvent: 'afterShellExecution', payloadText: cursorAfterShellExecution, cwd: '/unused', db, /** Implement out. */ out(s) { return written.push(s); } });
  assert.equal(code, 0);
  assert.equal(written.join(''), '');

  const observed = (await eventsOf(db, 'session.tool')).find(/** Find a matching item. */ (event) => event.source === 'hook' && event.adapter === 'cursor');
  assert.ok(observed);
  assert.equal(observed.payload.tool.name, 'shell');
  assert.equal(observed.payload.tool.input.command, 'pwd');
  assert.equal(JSON.parse(await db.get(observed.rawRef)).command, 'pwd');

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('forward records malformed payload diagnostics through the real daemon', /** Verify forward records malformed payload diagnostics through the real daemon. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = mkProject('malformed', '() => undefined');

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  const written = [];
  const code = await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: '{not json', cwd: proj, db, /** Implement out. */ out(s) { return written.push(s); } });
  assert.equal(code, 0);
  assert.equal(written.join(''), '');

  const diagnostics = await eventsOf(db, 'hook.diagnostic');
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (event) => event.payload.code === 'SUMO_HOOK_PAYLOAD_INVALID'));

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});

test('forward applies fail-open/closed policy to real daemon steering failures', /** Verify forward applies fail-open/closed policy to real daemon steering failures. */ async () => {
  const home = mkHome();
  const daemon = await startStorageDaemon({ home, idleShutdownMs: 0 });
  const db = await open({ home, autostart: false });

  const openWrites = [];
  const openCode = await forward({
    harness: 'claude-code',
    nativeEvent: 'PreToolUse',
    payloadText: preToolUse,
    cwd: '/proj',
    db,
    safety: false,
    /** Implement out. */ out(s) { return openWrites.push(s); }
  });
  assert.equal(openCode, 0);
  assert.equal(openWrites.join(''), '', 'non-safety hook allows when the real daemon cannot steer');

  const closedWrites = [];
  const closedCode = await forward({
    harness: 'claude-code',
    nativeEvent: 'PreToolUse',
    payloadText: preToolUse,
    cwd: '/proj',
    db,
    safety: true,
    /** Implement out. */ out(s) { return closedWrites.push(s); }
  });
  assert.equal(closedCode, 0);
  const native = JSON.parse(closedWrites.join(''));
  assert.equal(native.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(native.hookSpecificOutput.permissionDecisionReason, /failing closed/);

  const diagnostics = await eventsOf(db, 'hook.diagnostic');
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (event) => event.payload.code === 'SUMO_BAD_OP'));

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('forward observation failures from a real closed daemon client do not crash the hook', /** Verify forward observation failures from a real closed daemon client do not crash the hook. */ async () => {
  const home = mkHome();
  const daemon = await startStorageDaemon({ home, idleShutdownMs: 0 });
  const db = daemon.inProcessClient();
  await daemon.close();

  const written = [];
  const diagnostics = [];
  const code = await forward({
    harness: 'codex',
    nativeEvent: 'PostToolUse',
    payloadText: codexPostToolUse,
    cwd: '/unused',
    db,
    /** Implement out. */ out(s) { return written.push(s); },
    /** Implement appendDiag. */ async appendDiag(d) { diagnostics.push(d); }
  });

  assert.equal(code, 0);
  assert.equal(written.join(''), '');
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (diag) => diag.code === 'SUMO_HOOK_OBSERVE_FAILED'));

  fs.rmSync(home, { recursive: true, force: true });
});

test('forward reports an unknown harness through diagnostics, not native stdout', /** Verify forward reports an unknown harness through diagnostics, not native stdout. */ async () => {
  const written = [];
  const diagnostics = [];
  const code = await forward({
    harness: 'unknown-harness',
    nativeEvent: 'PreToolUse',
    payloadText: '{}',
    cwd: '/unused',
    /** Implement out. */ out(s) { return written.push(s); },
    /** Implement appendDiag. */ async appendDiag(d) { diagnostics.push(d); }
  });

  assert.equal(code, 0);
  assert.equal(written.join(''), '');
  assert.equal(diagnostics[0].code, 'SUMO_BAD_HARNESS');
  assert.match(diagnostics[0].message, /unknown-harness/);
});

test('warm forward round-trip fits comfortably inside the Claude hook-timeout headroom', /** Verify warm forward round-trip fits comfortably inside the Claude hook-timeout headroom. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = mkProject('latency', "() => ({ deny: 'x' })");

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  // Warm the project runtime (first call pays activation), then measure a steady-state round-trip.
  await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: preToolUse, cwd: proj, db, /** Implement out. */ out() {} });
  const t0 = performance.now();
  await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: preToolUse, cwd: proj, db, /** Implement out. */ out() {} });
  const warmMs = performance.now() - t0;
  // NOTE: this measures the in-test client→daemon→runtime path, NOT the real `sumo forward` PROCESS
  // (Node startup + imports + a fresh socket connect are additional; measured live in Step 6). The
  // ~5s plugin budget must stay < the harness hook timeout minus that startup.
  // eslint-disable-next-line no-console
  console.error(`[latency] warm steer round-trip: ${warmMs.toFixed(1)}ms`);
  assert.ok(warmMs < 1000, `warm round-trip should be well under the hook budget (was ${warmMs.toFixed(1)}ms)`);

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});

test('sessionId flows from native payload through steer boundary to before() handler', /** Verify sessionId flows from native payload through steer boundary to before() handler. */ async () => {
  // The PreToolUse fixture carries session_id: '90b87a52-aa09-4d67-a3fb-2ce672015e9c'.
  // Seeding a ses: doc with that harnessSessionId proves the steer-host correlates it to the
  // Sumo ULID and surfaces it on the SteerEvent that the plugin's before() handler receives.
  const nativeSessionId = '90b87a52-aa09-4d67-a3fb-2ce672015e9c';
  const sumoId = 'ses_01JWTEST0FWDSESSIONROUND01';
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = mkProject('sessionid', `(e) => e.sessionId ? { deny: 'sid:' + e.sessionId } : undefined`);

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  // Seed the ses: doc so the steer-host's correlate() can resolve the Sumo id.
  await db.put(key(sumoId), {
    id: sumoId,
    harness: 'claude-code',
    harnessSessionId: nativeSessionId,
    state: 'running',
    cwd: proj,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ext: {}
  });

  const written = [];
  const code = await forward({ harness: 'claude-code', nativeEvent: 'PreToolUse', payloadText: preToolUse, cwd: proj, db, /** Implement out. */ out(s) { return written.push(s); } });
  assert.equal(code, 0);

  // The plugin denies with 'sid:<sumoId>' — proving sessionId reached the before() handler.
  const native = JSON.parse(written.join(''));
  assert.equal(native.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    native.hookSpecificOutput.permissionDecisionReason.includes(sumoId),
    `deny reason should contain Sumo id; got: ${native.hookSpecificOutput.permissionDecisionReason}`
  );

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});
