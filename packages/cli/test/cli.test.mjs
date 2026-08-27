/**
 * Integration tests for the CLI handlers against a REAL `sumo/db` daemon and a REAL `sumo/plugin`
 * runtime (no mock APIs — CONVENTIONS testing rules). Handler-level tests receive those real
 * objects explicitly and capture only rendered output; `--json` output is asserted as structured data.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { open, key } from 'sumo/db';
import { plugin, fail } from 'sumo/plugin';
import { copilot as copilotHarness } from 'sumo/harness';

import {
  list,
  events,
  tail,
  commands,
  invoke,
  daemon,
  doctor,
  install,
  uninstall
} from '../src/index.mjs';
import { projectDrift } from '../src/install.mjs';

/** Capture rendered lines. */
function sink() {
  const lines = [];
  return { /** Implement out. */ out(l) { return lines.push(l); }, lines, /** Implement text. */ text() { return lines.join('\n'); } };
}

/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-')); }

/** Implement killByPid. */ function killByPid(home) {
  try {
    process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM');
  } catch { /* already gone */ }
}

/** Implement sleep. */ function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }
/** Test CLI subprocesses must not leave default-30m daemons behind after failures. */
function cliEnv(env = {}) { return { ...process.env, SUMO_IDLE_MS: '200', SUMO_PROJECT_IDLE_MS: '50', SUMO_INGEST: '0', ...env }; }
/** Implement until. */ async function until(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for condition');
}

/** Implement spawnNode. */ function spawnNode(args, env = {}, timeoutMs = 30_000) {
  const child = spawn(process.execPath, args, {
    env: cliEnv(env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', /** Run the callback. */ (chunk) => { stdout += chunk; });
  child.stderr.on('data', /** Run the callback. */ (chunk) => { stderr += chunk; });
  const done = new Promise(/** Run the callback. */ (resolve) => {
    child.on('close', /** Run the callback. */ (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timeout = setTimeout(/** Run the timer callback. */ () => child.kill('SIGKILL'), timeoutMs);
  timeout.unref?.();
  return {
    child,
    done: done.finally(/** Run the callback. */ () => clearTimeout(timeout))
  };
}

let ctx;
before(/** Run the before hook. */ async () => {
  const home = mkHome();
  const db = await open({ home, idleShutdownMs: 5000 });
  ctx = { home, db };
});
after(/** Run the after hook. */ async () => {
  await ctx.db.close();
  killByPid(ctx.home);
  fs.rmSync(ctx.home, { recursive: true, force: true });
});

test('cli entrypoint routes help and daemon status through the real process', /** Verify cli entrypoint routes help and daemon status through the real process. */ () => {
  const cli = path.resolve('packages/cli/src/cli.mjs');
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '1.0.0');

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /sumo — a window onto the running system/);

  const home = mkHome();
  try {
    const status = spawnSync(process.execPath, [cli, 'daemon', 'status', '--json'], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: home })
    });
    assert.equal(status.status, 1);
    assert.deepEqual(JSON.parse(status.stdout), { up: false, home });

    const harnesses = spawnSync(process.execPath, [cli, 'harnesses', '--json'], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: home })
    });
    assert.equal(harnesses.status, 0);
    const payload = JSON.parse(harnesses.stdout);
    assert.equal(payload.result.ok, true);
    assert.ok(payload.result.value.some(/** Test whether an item matches. */ (row) => row.id === 'codex'));
  } finally {
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('steering daemon entrypoint exits on idle and lock-loser startup', /** Verify steering daemon entrypoint exits on idle and lock-loser startup. */ async () => {
  const daemonMain = path.resolve('packages/cli/src/daemon-main.mjs');
  const idleHome = mkHome();
  try {
    const idle = spawnNode([daemonMain], {
      SUMO_HOME: idleHome,
      SUMO_IDLE_MS: '50',
      SUMO_SWEEP_MS: '50',
      SUMO_PROJECT_IDLE_MS: '20',
      SUMO_INGEST: '0'
    });
    const result = await idle.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  } finally {
    killByPid(idleHome);
    fs.rmSync(idleHome, { recursive: true, force: true });
  }

  const lockHome = mkHome();
  const first = spawnNode([daemonMain], {
    SUMO_HOME: lockHome,
    SUMO_IDLE_MS: '10000',
    SUMO_INGEST: '0'
  }, 40_000);
  try {
    await until(/** Run the callback. */ () => fs.existsSync(path.join(lockHome, 'sumo.pid')), 30_000);
    const loser = spawnNode([daemonMain], {
      SUMO_HOME: lockHome,
      SUMO_IDLE_MS: '10000',
      SUMO_INGEST: '0'
    });
    const result = await loser.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  } finally {
    first.child.kill('SIGTERM');
    await first.done;
    killByPid(lockHome);
    fs.rmSync(lockHome, { recursive: true, force: true });
  }
});

test('steering daemon entrypoint surfaces startup failures for an invalid SUMO_HOME path', /** Verify steering daemon entrypoint surfaces startup failures for an invalid SUMO_HOME path. */ () => {
  const daemonMain = path.resolve('packages/cli/src/daemon-main.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-daemon-main-bad-home-'));
  const invalidHome = path.join(dir, 'home-file');
  fs.writeFileSync(invalidHome, 'not-a-directory');
  try {
    const run = spawnSync(process.execPath, [daemonMain], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: invalidHome, SUMO_INGEST: '0' })
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /sumo steering daemon failed to start/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli entrypoint surfaces unexpected handler failures as process exit 1', /** Verify cli entrypoint surfaces unexpected handler failures as process exit 1. */ () => {
  const cli = path.resolve('packages/cli/src/cli.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-bad-home-'));
  const invalidHome = path.join(dir, 'home-file');
  fs.writeFileSync(invalidHome, 'not-a-directory');
  try {
    const status = spawnSync(process.execPath, [cli, 'daemon', 'status', '--json'], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: invalidHome })
    });
    assert.equal(status.status, 1);
    assert.equal(status.stdout, '');
    assert.match(status.stderr, /error|eexist|enotdir|not a directory/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli entrypoint generates plugin capability commands from --config forms', /** Verify cli entrypoint generates plugin capability commands from --config forms. */ () => {
  const cli = path.resolve('packages/cli/src/cli.mjs');
  const home = mkHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-dynamic-'));
  const pluginFile = path.join(projectDir, 'dynamic-plugin.mjs');
  const configFile = path.join(projectDir, 'sumo.yml');
  fs.writeFileSync(
    pluginFile,
    `export default function dynamicCliPlugin(sumo) {
  sumo.command('dynamic-echo', () => ({ message: 'dynamic command loaded from config' }));
  sumo.command('list', () => ({ unreachable: true }));
}
dynamicCliPlugin.sumo = { name: 'dynamic-cli-plugin' };
`
  );
  fs.writeFileSync(configFile, `use:\n  - ${JSON.stringify(pluginFile)}\n`);

  try {
    const afterCommand = spawnSync(process.execPath, [cli, 'dynamic-echo', '--json', '--config', configFile], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: home })
    });
    assert.equal(afterCommand.status, 0, afterCommand.stderr);
    assert.deepEqual(JSON.parse(afterCommand.stdout).result.value, { message: 'dynamic command loaded from config' });

    const equalsForm = spawnSync(process.execPath, [cli, `--config=${configFile}`, 'commands', '--json'], {
      encoding: 'utf8',
      env: cliEnv({ SUMO_HOME: home })
    });
    assert.equal(equalsForm.status, 0, equalsForm.stderr);
    assert.ok(JSON.parse(equalsForm.stdout).commands.some(/** Test whether an item matches. */ (row) => row.command === 'dynamic-echo'));
  } finally {
    killByPid(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});


test('list --json emits the seeded session docs', /** Verify list --json emits the seeded session docs. */ async () => {
  const a = { id: 'ses_a', harness: 'codex', state: 'running', cwd: '/x', createdAt: 1, updatedAt: 2, ext: {} };
  const b = { id: 'ses_b', harness: 'codex', state: 'done', cwd: '/y', createdAt: 3, updatedAt: 4, ext: {} };
  await ctx.db.put(key(a.id), a);
  await ctx.db.put(key(b.id), b);

  const s = sink();
  const code = await list({ json: true }, { db: ctx.db, out: s.out });
  assert.equal(code, 0);
  const rows = JSON.parse(s.text());
  const ids = rows.map(/** Map one item. */ (r) => r.id).sort();
  assert.deepEqual(ids, ['ses_a', 'ses_b']);
  assert.equal(rows.find(/** Find a matching item. */ (r) => r.id === 'ses_a').state, 'running');
});

test('events --json scans the log and filters by type/session', /** Verify events --json scans the log and filters by type/session. */ async () => {
  await ctx.db.append({ dedupe: 'd1', type: 'alpha', sessionId: 'ses_a', source: 'session', payload: {} });
  await ctx.db.append({ dedupe: 'd2', type: 'beta', sessionId: 'ses_a', source: 'plugin', payload: {} });
  await ctx.db.append({ dedupe: 'd3', type: 'alpha', sessionId: 'ses_b', source: 'session', payload: {} });

  const all = sink();
  await events({ json: true }, { db: ctx.db, out: all.out });
  const allRows = JSON.parse(all.text());
  assert.ok(allRows.length >= 3, 'all events scanned');
  assert.ok(allRows.every(/** Test whether every item matches. */ (e) => typeof e.seq === 'number'));

  const byType = sink();
  await events({ json: true, type: 'alpha' }, { db: ctx.db, out: byType.out });
  const alpha = JSON.parse(byType.text());
  assert.ok(alpha.length >= 2);
  assert.ok(alpha.every(/** Test whether every item matches. */ (e) => e.type === 'alpha'));

  const bySession = sink();
  await events({ json: true, type: 'alpha', session: 'ses_b' }, { db: ctx.db, out: bySession.out });
  const filtered = JSON.parse(bySession.text());
  assert.ok(filtered.every(/** Test whether every item matches. */ (e) => e.type === 'alpha' && e.sessionId === 'ses_b'));
  assert.ok(filtered.length >= 1);
});

test('events --since is exclusive (events strictly after the given seq)', /** Verify events --since is exclusive (events strictly after the given seq). */ async () => {
  const before = await ctx.db.append({ dedupe: 'since-before', type: 'mark', source: 'session', payload: {} });
  const after = await ctx.db.append({ dedupe: 'since-after', type: 'mark', source: 'session', payload: {} });
  const s = sink();
  await events({ json: true, since: before }, { db: ctx.db, out: s.out });
  const rows = JSON.parse(s.text());
  assert.ok(rows.every(/** Test whether every item matches. */ (e) => e.seq > before), 'all rows strictly after the watermark');
  assert.ok(rows.some(/** Test whether an item matches. */ (e) => e.seq === after), 'the next event is included');
  assert.ok(!rows.some(/** Test whether an item matches. */ (e) => e.seq === before), 'the watermark event itself is excluded');
});

test('events --since rejects invalid input with a SUMO_INVALID_ARGUMENT failure', /** Verify events --since rejects invalid input with a SUMO_INVALID_ARGUMENT failure. */ async () => {
  const s = sink();
  const code = await events({ json: true, since: 'abc' }, { db: ctx.db, out: s.out });
  assert.equal(code, 1);
  assert.equal(JSON.parse(s.text()).code, 'SUMO_INVALID_ARGUMENT');
});

test('tail replays filtered events from an explicit --since until the signal aborts', /** Verify tail replays filtered events from an explicit --since until the signal aborts. */ async () => {
  // Append first; subscribe replay from `since` covers already-logged events, so this is race-free.
  const e1 = await ctx.db.append({ dedupe: 'tail-1', type: 'tail-evt', sessionId: 'ses_a', source: 'session', payload: {} });
  const e2 = await ctx.db.append({ dedupe: 'tail-2', type: 'tail-evt', sessionId: 'ses_a', source: 'session', payload: {} });

  const controller = new AbortController();
  const s = sink();
  const done = tail(
    { json: true, type: 'tail-evt', since: String(e1 - 1) },
    { db: ctx.db, signal: controller.signal, out: s.out }
  );
  await until(/** Run the callback. */ () => s.lines.length >= 2);
  controller.abort();
  const code = await done;
  assert.equal(code, 0);

  const evts = s.lines.map(/** Map one item. */ (l) => JSON.parse(l));
  assert.ok(evts.every(/** Test whether every item matches. */ (e) => e.type === 'tail-evt'), 'filter limited the stream to the requested type');
  assert.ok(evts.some(/** Test whether an item matches. */ (e) => e.seq === e1) && evts.some(/** Test whether an item matches. */ (e) => e.seq === e2), 'both events delivered');
});

test('tail with no --since is live-only (does not replay the backlog) and aborts cleanly', /** Verify tail with no --since is live-only (does not replay the backlog) and aborts cleanly. */ async () => {
  // A historical event exists before tail starts; live-only tail must not emit it.
  await ctx.db.append({ dedupe: 'tail-hist', type: 'tail-live-evt', source: 'session', payload: {} });

  const controller = new AbortController();
  const s = sink();
  const done = tail({ json: true, type: 'tail-live-evt' }, { db: ctx.db, signal: controller.signal, out: s.out });
  await sleep(100); // no new events arrive
  controller.abort();
  const code = await done;
  assert.equal(code, 0);
  assert.equal(s.lines.length, 0, 'live-only tail did not replay the historical event');
});

test('tail renders human rows, rejects bad since, and exits immediately on an already-aborted signal', /** Verify tail renders human rows, rejects bad since, and exits immediately on an already-aborted signal. */ async () => {
  const invalid = sink();
  const invalidCode = await tail({ since: -1 }, { db: ctx.db, signal: new AbortController().signal, out: invalid.out });
  assert.equal(invalidCode, 1);
  assert.match(invalid.text(), /SUMO_INVALID_ARGUMENT/);

  const eventSeq = await ctx.db.append({ dedupe: 'tail-human', type: 'tail-human-evt', sessionId: 'ses_tail_human', source: 'session', payload: {} });
  const noSessionSeq = await ctx.db.append({ dedupe: 'tail-human-no-session', type: 'tail-human-evt', payload: {} });
  const controller = new AbortController();
  const human = sink();
  const done = tail(
    { type: 'tail-human-evt', session: 'ses_tail_human', since: eventSeq - 1 },
    { db: ctx.db, signal: controller.signal, out: human.out }
  );
  await until(/** Run the callback. */ () => human.lines.length >= 1);
  controller.abort();
  assert.equal(await done, 0);
  assert.match(human.text(), /tail-human-evt/);
  assert.match(human.text(), /ses_tail_human/);

  const noSession = new AbortController();
  const humanNoSession = sink();
  const noSessionDone = tail(
    { type: 'tail-human-evt', since: noSessionSeq - 1 },
    { db: ctx.db, signal: noSession.signal, out: humanNoSession.out }
  );
  await until(/** Run the callback. */ () => humanNoSession.lines.length >= 1);
  noSession.abort();
  assert.equal(await noSessionDone, 0);
  assert.match(humanNoSession.text(), new RegExp(`${noSessionSeq}\\ttail-human-evt\\t\\t`));

  const aborted = new AbortController();
  aborted.abort();
  const immediate = sink();
  assert.equal(await tail({ json: true }, { db: ctx.db, signal: aborted.signal, out: immediate.out }), 0);
});

test('commands lists a registered plugin command (real runtime, real daemon db)', /** Verify commands lists a registered plugin command (real runtime, real daemon db). */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo.command('echo', /** Run the callback. */ (args) => ({ echoed: args.msg }));
  await rt.start();
  try {
    const s = sink();
    await commands({ json: true }, { runtime: rt, out: s.out });
    const { commands: listed } = JSON.parse(s.text());
    const echo = listed.find(/** Find a matching item. */ (c) => c.command === 'echo');
    assert.ok(echo, 'echo command listed');
    assert.equal(echo.plugin, 'root');
    assert.equal(echo.hasSchema, false);
  } finally {
    await rt.stop();
  }
});

test('commands renders human output with diagnostics for unreachable built-in collisions', /** Verify commands renders human output with diagnostics for unreachable built-in collisions. */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo.command('list', /** Run the callback. */ () => ({ unreachable: true }));
  rt.sumo.command('visible-human', /** Run the callback. */ () => ({ ok: true }));
  await rt.start();
  try {
    const s = sink();
    assert.equal(await commands({}, { runtime: rt, out: s.out }), 0);
    assert.match(s.text(), /visible-human/);
    assert.match(s.text(), /SUMO_CLI_NAME_SHADOWED/);
    assert.doesNotMatch(s.text(), /^list\s/m, 'shadowed built-in is not advertised as a CLI command');
  } finally {
    await rt.stop();
  }
});

test('dynamic dispatch invokes a command and renders its (unwrapped) result; --json stays clean', /** Verify dynamic dispatch invokes a command and renders its (unwrapped) result; --json stays clean. */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo.command('greet', /** Run the callback. */ (args, c) => {
    c.print('side-channel noise that must not corrupt json');
    return { hello: args.who };
  });
  rt.sumo.command('boom', /** Run the callback. */ () => fail('SUMO_CAP_UNSUPPORTED', 'nope'));
  await rt.start();
  try {
    const s = sink();
    const code = await invoke('greet', { who: 'world' }, { json: true }, { runtime: rt, out: s.out });
    assert.equal(code, 0);
    // exactly one line of JSON on stdout (print was buffered, not written raw)
    assert.equal(s.lines.length, 1);
    const env = JSON.parse(s.text());
    assert.deepEqual(env.result, { ok: true, value: { hello: 'world' } });
    assert.deepEqual(env.prints, ['side-channel noise that must not corrupt json']);

    // a command returning a failure Result: invoke wraps it as ok(value); the envelope unwraps it
    const s2 = sink();
    const code2 = await invoke('boom', {}, { json: true }, { runtime: rt, out: s2.out });
    assert.equal(code2, 1);
    const env2 = JSON.parse(s2.text());
    assert.deepEqual(env2.result, { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'nope' });

    // unknown command → SUMO_NO_COMMAND failure
    const s3 = sink();
    const code3 = await invoke('missing', {}, { json: true }, { runtime: rt, out: s3.out });
    assert.equal(code3, 1);
    assert.equal(JSON.parse(s3.text()).result.code, 'SUMO_NO_COMMAND');
  } finally {
    await rt.stop();
  }
});

test('dynamic dispatch renders non-json prints, warnings and failures', /** Verify dynamic dispatch renders non-json prints, warnings and failures. */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo.command('noisy-human', /** Run the callback. */ (args, c) => {
    c.warn({ code: 'SUMO_TEST_WARNING', message: `warn ${args.what}`, severity: 'warning', source: {} });
    c.print(`printed ${args.what}`);
    return { done: args.what };
  });
  rt.sumo.command('fail-human', /** Run the callback. */ () => fail('SUMO_CAP_UNSUPPORTED', 'no human path'));
  await rt.start();
  try {
    const ok = sink();
    assert.equal(await invoke('noisy-human', { what: 'value' }, {}, { runtime: rt, out: ok.out }), 0);
    assert.match(ok.text(), /SUMO_TEST_WARNING/);
    assert.match(ok.text(), /printed value/);
    assert.match(ok.text(), /done/);

    const bad = sink();
    assert.equal(await invoke('fail-human', {}, {}, { runtime: rt, out: bad.out }), 1);
    assert.match(bad.text(), /SUMO_CAP_UNSUPPORTED/);
  } finally {
    await rt.stop();
  }
});

test('daemon status reports up for a live home and down for a never-started home', /** Verify daemon status reports up for a live home and down for a never-started home. */ async () => {
  // up: the shared ctx daemon
  const up = sink();
  const upCode = await daemon('status', { json: true }, { home: ctx.home, out: up.out });
  assert.equal(upCode, 0);
  assert.deepEqual(JSON.parse(up.text()), { up: true, home: ctx.home });

  // down: a fresh home that never had a daemon (autostart:false → SUMO_NO_DAEMON)
  const freshHome = mkHome();
  try {
    await until(/** Run the callback. */ async () => {
      const probe = sink();
      const code = await daemon('status', { json: true }, { home: freshHome, out: probe.out });
      return code === 1 && JSON.parse(probe.text()).up === false;
    });
  } finally {
    killByPid(freshHome);
    fs.rmSync(freshHome, { recursive: true, force: true });
  }
});

test('daemon start, stop, and restart control a real daemon', /** Verify daemon lifecycle commands operate on a real daemon. */ async () => {
  const home = mkHome();
  try {
    const started = sink();
    assert.equal(await daemon('start', { json: true }, { home, out: started.out }), 0);
    assert.deepEqual(JSON.parse(started.text()), { ok: true, value: { daemon: 'started', home } });

    const up = sink();
    assert.equal(await daemon('status', { json: true }, { home, out: up.out }), 0);
    assert.deepEqual(JSON.parse(up.text()), { up: true, home });

    const stopped = sink();
    assert.equal(await daemon('stop', { json: true }, { home, out: stopped.out }), 0);
    assert.deepEqual(JSON.parse(stopped.text()), { ok: true, value: { daemon: 'stopped', home } });

    const down = sink();
    assert.equal(await daemon('status', { json: true }, { home, out: down.out }), 1);
    assert.deepEqual(JSON.parse(down.text()), { up: false, home });

    const restarted = sink();
    assert.equal(await daemon('restart', { json: true }, { home, out: restarted.out }), 0);
    assert.deepEqual(JSON.parse(restarted.text()), { ok: true, value: { daemon: 'restarted', home } });
  } finally {
    try {
      const s = sink();
      await daemon('stop', { json: true }, { home, out: s.out });
    } catch {
      killByPid(home);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('daemon stop reports down daemon without autostarting', /** Verify daemon stop does not start a missing daemon. */ async () => {
  const home = mkHome();
  try {
    const s = sink();
    const code = await daemon('stop', { json: true }, { home, out: s.out });
    assert.equal(code, 1);
    assert.equal(JSON.parse(s.text()).code, 'SUMO_NO_DAEMON');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('daemon status renders human output with and without SUMO_HOME context', /** Verify daemon status renders human output with and without SUMO_HOME context. */ async () => {
  const up = sink();
  assert.equal(await daemon('status', {}, { home: ctx.home, out: up.out }), 0);
  assert.match(up.text(), /daemon: up/);
  assert.match(up.text(), /SUMO_HOME=/);

  const freshHome = mkHome();
  try {
    const down = sink();
    assert.equal(await daemon('status', {}, { env: { SUMO_HOME: freshHome }, out: down.out }), 1);
    assert.match(down.text(), /daemon: down/);
    assert.match(down.text(), /SUMO_HOME=/);
  } finally {
    killByPid(freshHome);
    fs.rmSync(freshHome, { recursive: true, force: true });
  }
});

test('daemon status and doctor rethrow unexpected daemon probe failures', /** Verify daemon status and doctor rethrow unexpected daemon probe failures. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-probe-error-'));
  const invalidHome = path.join(dir, 'home-file');
  fs.writeFileSync(invalidHome, 'not-a-directory');
  try {
    await assert.rejects(
      daemon('status', { json: true }, { home: invalidHome, out: sink().out }),
      /EEXIST|ENOTDIR|not a directory/i
    );
    await assert.rejects(
      doctor({ json: true }, { runtimeDiags: [], cwd: ctx.home, flags: {}, env: {}, home: invalidHome, out: sink().out }),
      /EEXIST|ENOTDIR|not a directory/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install and uninstall route through real harness installers with dry-run and unsupported paths', /** Verify install and uninstall route through real harness installers with dry-run and unsupported paths. */ async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-install-'));
  try {
    const copilotHookFile = path.join(projectDir, '.github', 'hooks', 'sumo.json');
    fs.mkdirSync(path.dirname(copilotHookFile), { recursive: true });
    fs.writeFileSync(copilotHookFile, `${JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ type: 'command', command: 'foreign-copilot-hook' }] }
    }, null, 2)}\n`);

    const dry = sink();
    assert.equal(await install({ harness: 'claude-code', projectDir, yes: false, out: dry.out }), 0);
    assert.match(dry.text(), /would install Sumo claude-code hooks/);

    const applied = sink();
    assert.equal(await install({ harness: 'codex', projectDir, yes: true, out: applied.out }), 0);
    assert.match(applied.text(), /installed|already up to date/);

    const copilotApplied = sink();
    assert.equal(await install({ harness: 'copilot', projectDir, yes: true, out: copilotApplied.out }), 0);
    assert.match(copilotApplied.text(), /installed|already up to date/);
    const installedCopilot = JSON.parse(fs.readFileSync(copilotHookFile, 'utf8'));
    assert.equal(installedCopilot.version, 1);
    assert.ok(installedCopilot.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'foreign-copilot-hook'));
    assert.ok(installedCopilot.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command.includes('sumo forward copilot preToolUse')));
    assert.ok(installedCopilot.hooks.agentStop.some(/** Test whether an item matches. */ (entry) => entry.command.includes('sumo forward copilot agentStop')));
    assert.ok(installedCopilot.hooks.notification.some(/** Test whether an item matches. */ (entry) => entry.command.includes('sumo forward copilot notification')));

    const customCopilot = copilotHarness.reconcile({
      version: 1,
      hooks: {
        preToolUse: [
          { type: 'command', command: `old ${copilotHarness.SENTINEL}` },
          { type: 'command', bash: `old bash ${copilotHarness.SENTINEL}` },
          { type: 'command', powershell: `old powershell ${copilotHarness.SENTINEL}` }
        ]
      }
    }, [{ event: 'preToolUse', matcher: 'Bash', safety: true, timeoutSec: 7 }], { bin: '/usr/local/bin/sumo forward copilot' });
    assert.deepEqual(customCopilot.hooks.preToolUse, [{
      type: 'command',
      command: `/usr/local/bin/sumo forward copilot preToolUse --safety ${copilotHarness.SENTINEL}`,
      matcher: 'Bash',
      timeoutSec: 7
    }]);
    assert.deepEqual(copilotHarness.strip(customCopilot), { version: 1 });

    const removeDry = sink();
    assert.equal(uninstall({ harness: 'codex', projectDir, yes: false, out: removeDry.out }), 0);
    assert.match(removeDry.text(), /would remove Sumo codex hooks/);

    const removed = sink();
    assert.equal(uninstall({ harness: 'codex', projectDir, yes: true, out: removed.out }), 0);
    assert.match(removed.text(), /removed Sumo hooks|no Sumo hooks present/);

    const copilotRemoved = sink();
    assert.equal(uninstall({ harness: 'copilot', projectDir, yes: true, out: copilotRemoved.out }), 0);
    assert.match(copilotRemoved.text(), /removed Sumo hooks|no Sumo hooks present/);
    assert.deepEqual(JSON.parse(fs.readFileSync(copilotHookFile, 'utf8')), {
      version: 1,
      hooks: { preToolUse: [{ type: 'command', command: 'foreign-copilot-hook' }] }
    });

    const unsupportedInstall = sink();
    assert.equal(await install({ harness: 'unknown-harness', projectDir, yes: true, out: unsupportedInstall.out }), 1);
    assert.match(unsupportedInstall.text(), /SUMO_UNSUPPORTED/);

    const unsupportedUninstall = sink();
    assert.equal(uninstall({ harness: 'unknown-harness', projectDir, yes: true, out: unsupportedUninstall.out }), 1);
    assert.match(unsupportedUninstall.text(), /SUMO_UNSUPPORTED/);

    const badConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-install-bad-'));
    fs.mkdirSync(path.join(badConfigDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(badConfigDir, '.codex', 'hooks.json'), '{ invalid json');
    fs.mkdirSync(path.join(badConfigDir, '.github', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(badConfigDir, '.github', 'hooks', 'sumo.json'), '{ invalid json');
    const badInstall = sink();
    assert.equal(await install({ harness: 'codex', projectDir: badConfigDir, yes: true, out: badInstall.out }), 1);
    assert.match(badInstall.text(), /SUMO_CONFIG_INVALID/);
    const badUninstall = sink();
    assert.equal(uninstall({ harness: 'codex', projectDir: badConfigDir, yes: true, out: badUninstall.out }), 1);
    assert.match(badUninstall.text(), /SUMO_CONFIG_INVALID/);
    const badCopilotInstall = sink();
    assert.equal(await install({ harness: 'copilot', projectDir: badConfigDir, yes: true, out: badCopilotInstall.out }), 1);
    assert.match(badCopilotInstall.text(), /SUMO_CONFIG_INVALID/);
    const badCopilotUninstall = sink();
    assert.equal(uninstall({ harness: 'copilot', projectDir: badConfigDir, yes: true, out: badCopilotUninstall.out }), 1);
    assert.match(badCopilotUninstall.text(), /SUMO_CONFIG_INVALID/);
    fs.rmSync(badConfigDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('project install reconciles hooks, MCP and Roundtable skill idempotently', /** Verify project install reconciles hooks, MCP and Roundtable skill idempotently. */ async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-'));
  const env = { CODEX_HOME: projectDir };
  const roundtable = path.resolve('plugins/roundtable/index.mjs');
  try {
    fs.writeFileSync(path.join(projectDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), `${JSON.stringify({ mcpServers: { foreign: { command: 'foreign-mcp' } } }, null, 2)}\n`);
    fs.mkdirSync(path.join(projectDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.codex', 'config.toml'), '[mcp_servers.foreign]\ncommand = "foreign-codex-mcp"\n');
    const copilotHookFile = path.join(projectDir, '.github', 'hooks', 'sumo.json');
    fs.mkdirSync(path.dirname(copilotHookFile), { recursive: true });
    fs.writeFileSync(copilotHookFile, `${JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', command: 'foreign-copilot-hook' }] } }, null, 2)}\n`);

    const first = sink();
    assert.equal(await install({ projectDir, yes: true, env, db: ctx.db, out: first.out }), 0);
    assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')));
    assert.ok(fs.existsSync(path.join(projectDir, '.codex', 'hooks.json')));
    assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
    assert.ok(fs.existsSync(copilotHookFile));
    let mcp = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.foreign.command, 'foreign-mcp');
    assert.deepEqual(mcp.mcpServers.sumo.args, ['mcp']);

    fs.writeFileSync(path.join(projectDir, 'sumo.yml'), `root: true\nuse:\n  - ${JSON.stringify(roundtable)}\n`);
    const rtBefore = plugin({ cwd: projectDir, env, db: ctx.db });
    await rtBefore.start();
    const intentsBefore = rtBefore.installIntents();
    await rtBefore.stop();

    const driftBefore = sink();
    assert.equal(await doctor({ json: true }, { cwd: projectDir, env, home: ctx.home, installIntents: intentsBefore, out: driftBefore.out }), 1);
    assert.ok(JSON.parse(driftBefore.text()).diagnostics.some(/** Test whether an item matches. */ (d) => /roundtable-coordinate/.test(d.message)));

    const second = sink();
    assert.equal(await install({ projectDir, yes: true, env, db: ctx.db, out: second.out }), 0);
    const skillFile = path.join(projectDir, '.agents', 'skills', 'roundtable-coordinate', 'SKILL.md');
    assert.match(fs.readFileSync(skillFile, 'utf8'), /roundtable-announce/);
    mcp = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.foreign.command, 'foreign-mcp');
    assert.deepEqual(JSON.parse(fs.readFileSync(copilotHookFile, 'utf8')).hooks.preToolUse[0].command, 'foreign-copilot-hook');
    const codexMcp = fs.readFileSync(path.join(projectDir, '.codex', 'config.toml'), 'utf8');
    assert.match(codexMcp, /\[mcp_servers\.foreign\]/);
    assert.match(codexMcp, /\[mcp_servers\.sumo\]/);
    assert.match(codexMcp, /SUMO_MANAGED = "sumo-managed:mcp"/);
    assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: roundtable-coordinate\n/m);

    const beforeText = fs.readFileSync(skillFile, 'utf8') + fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8') + fs.readFileSync(path.join(projectDir, '.codex', 'config.toml'), 'utf8');
    const third = sink();
    assert.equal(await install({ projectDir, yes: true, env, db: ctx.db, out: third.out }), 0);
    assert.equal(fs.readFileSync(skillFile, 'utf8') + fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8') + fs.readFileSync(path.join(projectDir, '.codex', 'config.toml'), 'utf8'), beforeText);

    const rtAfter = plugin({ cwd: projectDir, env, db: ctx.db });
    await rtAfter.start();
    const intentsAfter = rtAfter.installIntents();
    await rtAfter.stop();
    const driftAfter = sink();
    assert.equal(await doctor({ json: true }, { cwd: projectDir, env, home: ctx.home, installIntents: intentsAfter, out: driftAfter.out }), 0);
    assert.deepEqual(JSON.parse(driftAfter.text()).diagnostics.filter(/** Select matching items. */ (d) => d.code === 'SUMO_INSTALL_DRIFT'), []);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('projectDrift returns no install diagnostics for unmanaged directories and reports detailed skill drift states', /** Verify projectDrift skips unmanaged directories and reports missing sources, unreadable hooks, missing frontmatter, missing installs, and stale installs. */ () => {
  const unmanagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-drift-unmanaged-'));
  const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-drift-managed-'));
  try {
    assert.deepEqual(projectDrift({ projectDir: unmanagedDir }), []);

    fs.writeFileSync(path.join(managedDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.mkdirSync(path.join(managedDir, '.codex', 'hooks.json'), { recursive: true });

    const missingDestSource = path.join(managedDir, 'missing-dest-source.md');
    fs.writeFileSync(missingDestSource, '---\nname: missing-dest\n---\nsource text\n');

    const noFrontmatterSource = path.join(managedDir, 'no-frontmatter-source.md');
    fs.writeFileSync(noFrontmatterSource, '---\nname: no-frontmatter\n---\nsource text\n');
    const noFrontmatterDest = path.join(managedDir, '.agents', 'skills', 'no-frontmatter', 'SKILL.md');
    fs.mkdirSync(path.dirname(noFrontmatterDest), { recursive: true });
    fs.writeFileSync(noFrontmatterDest, 'plain text without frontmatter\n');

    const staleSource = path.join(managedDir, 'stale-source.md');
    fs.writeFileSync(staleSource, '---\nname: stale-skill\n---\nnew text\n');
    const staleDest = path.join(managedDir, '.agents', 'skills', 'stale-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(staleDest), { recursive: true });
    fs.writeFileSync(staleDest, '---\nname: stale-skill\n---\nold text\n');

    const diagnostics = projectDrift({
      projectDir: managedDir,
      installIntents: [
        { plugin: 'broken-plugin', spec: { skills: [{ name: 'missing-source', source: 'missing-source.md' }] } },
        { plugin: 'missing-dest-plugin', spec: { skills: [{ name: 'missing-dest', source: path.basename(missingDestSource) }] } },
        { plugin: 'frontmatter-plugin', spec: { skills: [{ name: 'no-frontmatter', source: path.basename(noFrontmatterSource) }] } },
        { plugin: 'stale-plugin', spec: { skills: [{ name: 'stale-skill', source: path.basename(staleSource) }] } }
      ]
    });

    assert.ok(diagnostics.some((d) => /could not inspect codex hooks/.test(d.message ?? '')));
    assert.ok(diagnostics.some((d) => /missing skill 'missing-dest'/.test(d.message ?? '')));
    assert.ok(diagnostics.some((d) => /missing YAML frontmatter/.test(d.message ?? '')));
    assert.ok(diagnostics.some((d) => /skill 'stale-skill' is out of date/.test(d.message ?? '')));
    assert.ok(diagnostics.some((d) => /could not read skill source .*missing-source\.md/.test(d.message ?? '')));
  } finally {
    fs.rmSync(unmanagedDir, { recursive: true, force: true });
    fs.rmSync(managedDir, { recursive: true, force: true });
  }
});

test('projectDrift treats blank and invalid MCP JSON honestly and recognizes both Sumo MCP marker forms', /** Verify projectDrift covers blank and invalid MCP JSON plus env-marker and command-marker MCP ownership detection. */ () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-drift-mcp-'));
  try {
    fs.writeFileSync(path.join(projectDir, 'sumo.yml'), 'root: true\nuse: []\n');

    fs.writeFileSync(path.join(projectDir, '.mcp.json'), '\n');
    fs.mkdirSync(path.join(projectDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.cursor', 'mcp.json'), '{ invalid json');
    let diagnostics = projectDrift({ projectDir });
    assert.ok(diagnostics.some((d) => /missing Sumo MCP server in \.mcp\.json/.test(d.message ?? '')));
    assert.ok(diagnostics.some((d) => /missing Sumo MCP server in \.cursor\/mcp\.json/.test(d.message ?? '')));

    fs.writeFileSync(path.join(projectDir, '.mcp.json'), `${JSON.stringify({
      mcpServers: { sumo: { env: { SUMO_MANAGED: 'sumo-managed:mcp' } }, foreign: 'not-an-object' }
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(projectDir, '.cursor', 'mcp.json'), `${JSON.stringify({
      mcpServers: { sumo: { command: 'sumo', args: ['mcp'] } }
    }, null, 2)}\n`);
    diagnostics = projectDrift({ projectDir });
    assert.equal(diagnostics.some((d) => /missing Sumo MCP server in \.mcp\.json/.test(d.message ?? '')), false);
    assert.equal(diagnostics.some((d) => /missing Sumo MCP server in \.cursor\/mcp\.json/.test(d.message ?? '')), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('project install reports config errors, installer failures, and Codex feature warnings through the real reconciliation path', /** Verify project install handles config diagnostics, hook installer failures, and Codex warnings through installProject. */ async () => {
  const invalidConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-invalid-config-'));
  const badHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-bad-hooks-'));
  const warningProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-warning-'));
  const warningHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-warning-home-'));
  try {
    fs.writeFileSync(path.join(invalidConfigDir, 'sumo.yml'), 'root: [\n');
    const invalidConfig = sink();
    assert.equal(await install({ projectDir: invalidConfigDir, yes: true, env: { CODEX_HOME: invalidConfigDir }, db: ctx.db, out: invalidConfig.out }), 1);
    assert.match(invalidConfig.text(), /SUMO_CONFIG_/);

    fs.writeFileSync(path.join(badHooksDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.mkdirSync(path.join(badHooksDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(badHooksDir, '.codex', 'hooks.json'), '{ invalid json');
    const badHooks = sink();
    assert.equal(await install({ projectDir: badHooksDir, yes: true, env: { CODEX_HOME: badHooksDir }, db: ctx.db, out: badHooks.out }), 1);
    assert.match(badHooks.text(), /SUMO_CONFIG_INVALID/);

    fs.writeFileSync(path.join(warningProjectDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.mkdirSync(path.join(warningHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(warningHome, '.codex', 'config.toml'), '[features]\nhooks = false\n');
    const warningRun = sink();
    assert.equal(await install({
      projectDir: warningProjectDir,
      yes: true,
      env: { HOME: warningHome, CODEX_HOME: path.join(warningHome, '.codex') },
      db: ctx.db,
      out: warningRun.out
    }), 0);
    assert.match(warningRun.text(), /warning: Codex hooks require the stable `hooks` feature/);
  } finally {
    fs.rmSync(invalidConfigDir, { recursive: true, force: true });
    fs.rmSync(badHooksDir, { recursive: true, force: true });
    fs.rmSync(warningProjectDir, { recursive: true, force: true });
    fs.rmSync(warningHome, { recursive: true, force: true });
  }
});

test('project install handles dry-run, plugin diagnostics, missing plugin-owned skill sources, and unreadable MCP configs', /** Verify project install exercises dry-run, plugin-runtime diagnostic, plugin-owned skill install failure, and MCP file read-failure branches. */ async () => {
  const dryRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-dry-run-'));
  const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-diag-'));
  const throwingDiagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-throwing-diag-'));
  const missingSkillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-missing-skill-'));
  const badJsonMcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-bad-json-mcp-'));
  const badCodexMcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-project-install-bad-codex-mcp-'));
  try {
    const dryRun = sink();
    assert.equal(await install({ projectDir: dryRunDir, yes: false, out: dryRun.out }), 0);
    assert.match(dryRun.text(), /would reconcile Sumo project setup under/);

    fs.writeFileSync(path.join(diagDir, 'sumo.yml'), 'root: true\nuse:\n  - "./missing-plugin.mjs"\n');
    const runtimeDiag = sink();
    assert.equal(await install({ projectDir: diagDir, yes: true, env: { CODEX_HOME: diagDir }, db: ctx.db, out: runtimeDiag.out }), 1);
    assert.match(runtimeDiag.text(), /missing-plugin\.mjs/);

    const throwingPlugin = path.join(throwingDiagDir, 'throwing-plugin.mjs');
    fs.writeFileSync(path.join(throwingDiagDir, 'sumo.yml'), `root: true\nuse:\n  - ${JSON.stringify(throwingPlugin)}\n`);
    fs.writeFileSync(
      throwingPlugin,
      `import { SumoError } from ${JSON.stringify(path.resolve('packages/error/src/index.mjs'))};

export default function throwingPlugin() {
  throw new SumoError({ name: 'plugin', method: 'activate', code: 'SUMO_THROWN_PLUGIN', message: 'exploded during activation' });
}
throwingPlugin.sumo = { name: 'throwing-plugin' };
`
    );
    const thrownDiag = sink();
    assert.equal(await install({ projectDir: throwingDiagDir, yes: true, env: { CODEX_HOME: throwingDiagDir }, db: ctx.db, out: thrownDiag.out }), 1);
    assert.match(thrownDiag.text(), /exploded during activation/);

    const missingSkillPlugin = path.join(missingSkillDir, 'missing-skill-plugin.mjs');
    fs.writeFileSync(path.join(missingSkillDir, 'sumo.yml'), `root: true\nuse:\n  - ${JSON.stringify(missingSkillPlugin)}\n`);
    fs.writeFileSync(
      missingSkillPlugin,
      `export default function missingSkillPlugin(sumo) {
  sumo.install({ skills: [{ name: 'missing-skill', source: './missing-skill.md' }] });
}
missingSkillPlugin.sumo = { name: 'missing-skill-plugin' };
`
    );
    const missingSkill = sink();
    assert.equal(await install({ projectDir: missingSkillDir, yes: true, env: { CODEX_HOME: missingSkillDir }, db: ctx.db, out: missingSkill.out }), 1);
    assert.match(missingSkill.text(), /SUMO_INSTALL_SOURCE_MISSING/);

    fs.writeFileSync(path.join(badJsonMcpDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.mkdirSync(path.join(badJsonMcpDir, '.mcp.json'));
    const badJsonMcp = sink();
    assert.equal(await install({ projectDir: badJsonMcpDir, yes: true, env: { CODEX_HOME: badJsonMcpDir }, db: ctx.db, out: badJsonMcp.out }), 1);
    assert.match(badJsonMcp.text(), /SUMO_CONFIG_READ/);

    fs.writeFileSync(path.join(badCodexMcpDir, 'sumo.yml'), 'root: true\nuse: []\n');
    fs.mkdirSync(path.join(badCodexMcpDir, '.codex', 'config.toml'), { recursive: true });
    const badCodexMcp = sink();
    assert.equal(await install({ projectDir: badCodexMcpDir, yes: true, env: { CODEX_HOME: badCodexMcpDir }, db: ctx.db, out: badCodexMcp.out }), 1);
    assert.match(badCodexMcp.text(), /SUMO_CONFIG_READ/);
  } finally {
    fs.rmSync(dryRunDir, { recursive: true, force: true });
    fs.rmSync(diagDir, { recursive: true, force: true });
    fs.rmSync(throwingDiagDir, { recursive: true, force: true });
    fs.rmSync(missingSkillDir, { recursive: true, force: true });
    fs.rmSync(badJsonMcpDir, { recursive: true, force: true });
    fs.rmSync(badCodexMcpDir, { recursive: true, force: true });
  }
});

test('doctor --json combines daemon reachability, plugins and diagnostics', /** Verify doctor --json combines daemon reachability, plugins and diagnostics. */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  await rt.start();
  try {
    const s = sink();
    const code = await doctor(
      { json: true },
      { runtimeDiags: rt.diagnostics(), cwd: ctx.home, flags: {}, env: {}, home: ctx.home, out: s.out }
    );
    const report = JSON.parse(s.text());
    assert.equal(report.daemon.up, true);
    assert.ok(Array.isArray(report.plugins));
    assert.ok(Array.isArray(report.diagnostics));
    assert.equal(code, 0); // daemon up + no error-severity diagnostics with an empty config
  } finally {
    await rt.stop();
  }
});

test('doctor reports daemon-down (degraded) and exits non-zero', /** Verify doctor reports daemon-down (degraded) and exits non-zero. */ async () => {
  // a fresh home with no daemon → the probe reports down; doctor still renders a report
  const freshHome = mkHome();
  try {
    const s = sink();
    const code = await doctor(
      { json: true },
      { runtimeDiags: [{ code: 'SUMO_NO_DAEMON', message: 'no daemon', severity: 'error', source: {} }], cwd: freshHome, flags: {}, env: {}, home: freshHome, out: s.out }
    );
    const report = JSON.parse(s.text());
    assert.equal(report.daemon.up, false);
    assert.equal(code, 1, 'daemon down → non-zero exit');
  } finally {
    killByPid(freshHome);
    fs.rmSync(freshHome, { recursive: true, force: true });
  }
});

test('doctor human report includes harness rows, plugin rows and diagnostics', /** Verify doctor human report includes harness rows, plugin rows and diagnostics. */ async () => {
  const configFile = path.join(ctx.home, 'doctor-human.yml');
  fs.writeFileSync(configFile, 'use: [missing-plugin]\nplugins:\n  missing-plugin:\n    enabled: true\n');
  const s = sink();
  const code = await doctor(
    {},
    {
      runtimeDiags: [{ code: 'SUMO_TEST_DIAG', message: 'human diagnostic', severity: 'warning', source: {} }],
      harnessRows: [
        { id: 'codex', status: 'available', version: '1.0.0', providers: ['openai'] },
        { id: 'cursor', status: 'missing' }
      ],
      cwd: ctx.home,
      flags: { config: configFile },
      env: {},
      home: ctx.home,
      out: s.out
    }
  );
  assert.equal(code, 1);
  assert.match(s.text(), /codex/);
  assert.match(s.text(), /cursor/);
  assert.match(s.text(), /missing/);
  assert.match(s.text(), /missing-plugin/);
  assert.match(s.text(), /SUMO_TEST_DIAG/);
  assert.match(s.text(), /SUMO_INSTALL_DRIFT/);
});

test('doctor human report renders empty harness and plugin sections honestly', /** Verify doctor human report renders empty harness and plugin sections honestly. */ async () => {
  const s = sink();
  const code = await doctor(
    {},
    {
      runtimeDiags: [],
      harnessRows: [],
      cwd: ctx.home,
      flags: {},
      env: {},
      home: ctx.home,
      out: s.out
    }
  );
  assert.equal(code, 0);
  assert.match(s.text(), /\(none registered\)/);
  assert.match(s.text(), /\(none configured\)/);
});
