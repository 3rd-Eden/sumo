/**
 * Contract tests for the transport layer — exercised against REAL subprocesses (`node` emitting
 * frames), not mocks, per CONVENTIONS §3f. They prove the mechanics the `Harness` base relies on:
 * line framing, stdin `send`, the rolling `capture()` snapshot, health on exit, and that the abstract
 * `Transport` refuses to be used directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transport, Pipe, Subprocess } from '../src/transport/index.mjs';

const NODE = process.execPath;

test('Subprocess: pumps stdout chunks and reports close (code,signal)', /** Verify Subprocess: pumps stdout chunks and reports close (code,signal). */ async () => {
  const proc = new Subprocess({ command: NODE, args: ['-e', 'process.stdout.write("hello")'] });
  proc.start();
  proc.start();
  assert.equal(typeof proc.pid, 'number');
  let out = '';
  for await (const chunk of proc.chunks()) out += chunk.toString();
  assert.equal(out, 'hello');
  assert.equal(proc.health.alive, false);
  assert.equal(proc.health.code, 0);
});

test('Subprocess: captures real OS spawn errors and stderr evidence', /** Verify Subprocess: captures real OS spawn errors and stderr evidence. */ async () => {
  const missing = new Subprocess({ command: pathlessMissingCommand() });
  missing.start();
  for await (const _chunk of missing.chunks()) void _chunk;
  assert.equal(missing.health.alive, false);
  assert.equal(missing.evidence.spawnError?.code, 'ENOENT');

  const stderr = new Subprocess({ command: NODE, args: ['-e', 'process.stderr.write("stderr evidence"); process.exit(7)'] });
  stderr.start();
  for await (const _chunk of stderr.chunks()) void _chunk;
  assert.equal(stderr.health.code, 7);
  assert.match(stderr.evidence.stderr, /stderr evidence/);
});

test('Subprocess: launch options are honored and close is safe before start', /** Verify Subprocess: launch options are honored and close is safe before start. */ async () => {
  const unopened = new Subprocess({ command: NODE, args: ['-e', ''] });
  await unopened.close();
  unopened.signal('SIGTERM');
  unopened.kill();

  const proc = new Subprocess({
    command: NODE,
    args: ['-e', 'process.stdout.write(process.env.SUMO_CHILD_FLAG)'],
    env: { SUMO_CHILD_FLAG: 'from-env' },
    detached: true
  });
  proc.start();
  let out = '';
  for await (const chunk of proc.chunks()) out += chunk.toString();
  assert.equal(out, 'from-env');
  assert.equal(proc.health.code, 0);
});

test('Subprocess: EOF, SIGINT and forced close drive real child lifecycle', /** Verify Subprocess: EOF, SIGINT and forced close drive real child lifecycle. */ async () => {
  const eof = new Subprocess({ command: NODE, args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("ended"))'] });
  eof.start();
  eof.endInput();
  let out = '';
  for await (const chunk of eof.chunks()) out += chunk.toString();
  assert.equal(out, 'ended');
  assert.equal(eof.health.code, 0);

  const interrupted = new Subprocess({ command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] });
  interrupted.start();
  interrupted.signal('SIGINT');
  for await (const _chunk of interrupted.chunks()) void _chunk;
  assert.equal(interrupted.health.signal, 'SIGINT');
  await assert.rejects(/** Run the callback. */ () => interrupted.write('after close'), /not writable|EPIPE|ERR_STREAM/);

  const stubborn = new Subprocess({ command: NODE, args: ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'] });
  stubborn.start();
  const stubbornChunks = stubborn.chunks();
  const first = await stubbornChunks.next();
  assert.equal(first.value.toString(), 'ready');
  await stubborn.close({ timeoutMs: 20 });
  assert.equal(stubborn.health.signal, 'SIGKILL');
});

test('Pipe (default): frames newline-JSON and surfaces non-JSON lines as raw frames', /** Verify Pipe (default): frames newline-JSON and retains non-JSON lines. */ async () => {
  const script = 'process.stdout.write(\'\\n{"type":"a"}\\nnot json\\n{"type":"b"}\\n\')';
  const pipe = new Pipe({ command: NODE, args: ['-e', script] });
  assert.deepEqual(pipe.health, { alive: false });
  assert.deepEqual(pipe.evidence, { stderr: '', spawnError: null, exitCode: null, signal: null, snapshot: '' });
  assert.equal(pipe.pid, null);
  await pipe.close();
  await pipe.open();
  const frames = [];
  for await (const f of pipe.frames()) frames.push(f);
  assert.deepEqual(frames, [{ type: 'a' }, { __sumoRawStdout: 'not json' }, { type: 'b' }]);
});

test('Pipe (default): capture() returns the rolling raw snapshot', /** Verify Pipe (default): capture() returns the rolling raw snapshot. */ async () => {
  const pipe = new Pipe({ command: NODE, args: ['-e', 'process.stdout.write("raw-output-here\\n")'] });
  await pipe.open();
  for await (const _ of pipe.frames()) void _; // drain to EOF so the snapshot is populated
  const snap = await pipe.capture();
  assert.match(snap, /raw-output-here/);
  assert.equal(typeof snap, 'string');
});

test('Pipe (default): send() writes to stdin and is read back as a frame', /** Verify Pipe (default): send() writes to stdin and is read back as a frame. */ async () => {
  // Echo one stdin line back as a JSON frame, then exit.
  const script = `
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\\n');
      if (i >= 0) { process.stdout.write(JSON.stringify({ echo: buf.slice(0, i) }) + '\\n'); process.exit(0); }
    });
  `;
  const pipe = new Pipe({ command: NODE, args: ['-e', script] });
  await pipe.open();
  await pipe.send('ping\n');
  const frames = [];
  for await (const f of pipe.frames()) frames.push(f);
  assert.deepEqual(frames, [{ echo: 'ping' }]);
});

test('Pipe (default): EOF, interrupt and evidence follow the real subprocess', /** Verify Pipe (default): EOF, interrupt and evidence follow the real subprocess. */ async () => {
  const eof = new Pipe({
    command: NODE,
    args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ended: true }) + "\\n"))']
  });
  await eof.open();
  eof.endInput();
  const eofFrames = [];
  for await (const f of eof.frames()) eofFrames.push(f);
  assert.deepEqual(eofFrames, [{ ended: true }]);

  const evidence = new Pipe({
    command: NODE,
    args: ['-e', 'process.stderr.write("stderr evidence"); process.stdout.write("banner line\\n" + JSON.stringify({ ok: true }) + "\\n")']
  });
  await evidence.open();
  const frames = [];
  for await (const f of evidence.frames()) frames.push(f);
  assert.deepEqual(frames, [{ __sumoRawStdout: 'banner line' }, { ok: true }]);
  assert.match(evidence.evidence.stderr, /stderr evidence/);
  assert.match(evidence.evidence.snapshot, /banner line/);

  const interrupted = new Pipe({ command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await interrupted.open();
  assert.deepEqual(await interrupted.interrupt(), { ok: true });
  for await (const _ of interrupted.frames()) void _;
  assert.equal(interrupted.health.alive, false);
  const dead = await interrupted.interrupt();
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'SUMO_SESSION_DEAD');

  const killed = new Pipe({ command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await killed.open();
  killed.kill();
  for await (const _ of killed.frames()) void _;
  assert.equal(killed.health.signal, 'SIGKILL');
});

test('Transport: abstract methods refuse direct use', /** Verify Transport: abstract methods refuse direct use. */ async () => {
  const t = new Transport();
  assert.deepEqual(t.health, { alive: false });
  await assert.rejects(/** Run the callback. */ () => t.open(), /abstract/);
  assert.throws(/** Run the callback. */ () => t.frames(), /abstract/);
  await assert.rejects(/** Run the callback. */ () => t.close(), /abstract/);
  assert.throws(/** Run the callback. */ () => t.kill(), /abstract/);
});

/** Implement pathlessMissingCommand. */ function pathlessMissingCommand() {
  return `sumo-missing-command-${process.pid}-${Date.now()}`;
}
