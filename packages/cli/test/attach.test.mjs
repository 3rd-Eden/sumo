/**
 * `sumo attach` — Phase 2. Attach hands the user's real terminal to the harness's OWN native
 * interactive resume rather than re-implementing a stream-back. These tests cover the resolution logic
 * (harness → native-id → argv → bin) against a REAL temp daemon with seeded `ses:` docs; the exec
 * boundary launches a real local child process instead of replacing child_process.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { key } from 'sumo/db';
import { Claude, Cursor, Codex, Harness } from 'sumo/harness';
import { attach } from '../src/index.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement seed. */ function seed(id, patch) { return ctx.db.put(key(id), { id, harness: 'claude-code', state: 'ended', createdAt: 1, updatedAt: 1, ext: {}, ...patch }); }

/** Implement attachCommand. */ function attachCommand({ code = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-attach-bin-'));
  const bin = path.join(dir, 'sumo-attach-command.mjs');
  const capture = path.join(dir, 'capture.json');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${code});
`
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    capture,
    /** Implement read. */ read() { return JSON.parse(fs.readFileSync(capture, 'utf8')); },
    /** Implement cleanup. */ cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Implement signalExitCommand. */ function signalExitCommand(signal = 'SIGTERM') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-attach-signal-bin-'));
  const bin = path.join(dir, 'sumo-attach-signal.mjs');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
process.kill(process.pid, ${JSON.stringify(signal)});
`
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    /** Implement cleanup. */ cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Implement writeHarnessBin. */ function writeHarnessBin(harness, bin) {
  fs.writeFileSync(path.join(ctx.home, 'sumo.yml'), `harness:\n  ${harness}:\n    bin: ${JSON.stringify(bin)}\n`);
}

test('interactiveResumeArgv per adapter (native resume), base declares unsupported', /** Verify interactiveResumeArgv per adapter (native resume), base declares unsupported. */ () => {
  assert.deepEqual(new Claude({ config: {} }).interactiveResumeArgv('abc'), ['--resume', 'abc']);
  assert.deepEqual(new Cursor({ config: {} }).interactiveResumeArgv('abc'), ['--resume', 'abc']);
  assert.deepEqual(new Codex({ config: {} }).interactiveResumeArgv('abc'), ['resume', 'abc']);
  // a bare Harness (no native interactive resume) declares it rather than faking
  assert.equal(new Harness().interactiveResumeArgv('abc'), null);
  assert.equal(new Claude({ config: {} }).interactiveResumeArgv(''), null, 'no native id → null');
});

test('attach resolves the native resume command + bin + cwd and returns the child exit code', /** Verify attach resolves the native resume command + bin + cwd and returns the child exit code. */ async () => {
  await seed('ses_claude', { harness: 'claude-code', harnessSessionId: 'native-1', cwd: '/tmp/projX' });
  fs.mkdirSync('/tmp/projX', { recursive: true });
  const command = attachCommand();
  try {
    writeHarnessBin('claude-code', command.bin);
    const code = await attach(
      { sessionId: 'ses_claude' },
      { db: ctx.db, env: { SUMO_HOME: ctx.home }, cwd: '/tmp', /** Implement out. */ out() {} }
    );
    assert.equal(code, 0);
    const captured = command.read();
    assert.deepEqual(captured.argv, ['--resume', 'native-1']);
    assert.equal(captured.cwd, fs.realpathSync('/tmp/projX'), 'runs in the session\'s recorded cwd');
  } finally {
    command.cleanup();
  }
});

test('attach resolves codex as a subcommand and propagates a non-zero exit code', /** Verify attach resolves codex as a subcommand and propagates a non-zero exit code. */ async () => {
  await seed('ses_codex', { harness: 'codex', harnessSessionId: 'thread-9', cwd: '/tmp/projY' });
  fs.mkdirSync('/tmp/projY', { recursive: true });
  const command = attachCommand({ code: 3 });
  try {
    writeHarnessBin('codex', command.bin);
    const code = await attach(
      { sessionId: 'ses_codex' },
      { db: ctx.db, env: { SUMO_HOME: ctx.home }, /** Implement out. */ out() {} }
    );
    assert.equal(code, 3, 'native exit code propagates');
    assert.deepEqual(command.read().argv, ['resume', 'thread-9']);
  } finally {
    command.cleanup();
  }
});

test('attach treats a native signal-only close as a completed handoff', /** Verify attach treats a native signal-only close as a completed handoff. */ async () => {
  await seed('ses_claude_signal', { harness: 'claude-code', harnessSessionId: 'native-signal', cwd: '/tmp/proj-signal' });
  fs.mkdirSync('/tmp/proj-signal', { recursive: true });
  const command = signalExitCommand();
  try {
    writeHarnessBin('claude-code', command.bin);
    const code = await attach(
      { sessionId: 'ses_claude_signal' },
      { db: ctx.db, env: { SUMO_HOME: ctx.home }, /** Implement out. */ out() {} }
    );
    assert.equal(code, 0);
  } finally {
    command.cleanup();
  }
});

test('attach falls back to the caller cwd when the session doc has none', /** Verify attach falls back to the caller cwd when the session doc has none. */ async () => {
  await seed('ses_claude_no_cwd', { harness: 'claude-code', harnessSessionId: 'native-no-cwd' });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-attach-caller-cwd-'));
  const command = attachCommand();
  try {
    writeHarnessBin('claude-code', command.bin);
    const code = await attach(
      { sessionId: 'ses_claude_no_cwd' },
      { db: ctx.db, env: { SUMO_HOME: ctx.home }, cwd: runDir, /** Implement out. */ out() {} }
    );
    assert.equal(code, 0);
    assert.deepEqual(command.read().argv, ['--resume', 'native-no-cwd']);
    assert.equal(command.read().cwd, fs.realpathSync(runDir));
  } finally {
    command.cleanup();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('attach fails honestly: unknown session, no native id', /** Verify attach fails honestly: unknown session, no native id. */ async () => {
  const lines = [];
  /** Implement out. */ function out(l) { return lines.push(l); }

  const c0 = await attach({ json: true }, { db: ctx.db, env: { SUMO_HOME: ctx.home }, out });
  assert.equal(c0, 1);
  assert.match(lines.join('\n'), /SUMO_INVALID_ARGUMENT/);

  lines.length = 0;
  const c1 = await attach({ sessionId: 'ses_missing', json: true }, { db: ctx.db, env: { SUMO_HOME: ctx.home }, out });
  assert.equal(c1, 1);
  assert.match(lines.join('\n'), /SUMO_SESSION_UNKNOWN/);

  await seed('ses_nonat', { harness: 'claude-code', cwd: '/tmp/p' }); // no harnessSessionId
  lines.length = 0;
  const c2 = await attach({ sessionId: 'ses_nonat', json: true }, { db: ctx.db, env: { SUMO_HOME: ctx.home }, out });
  assert.equal(c2, 1);
  assert.match(lines.join('\n'), /SUMO_CAP_UNSUPPORTED/);

  await seed('ses_unknown_harness', { harness: 'unknown-live-harness', harnessSessionId: 'native-2', cwd: '/tmp/p' });
  lines.length = 0;
  const c3 = await attach({ sessionId: 'ses_unknown_harness', json: true }, { db: ctx.db, env: { SUMO_HOME: ctx.home }, out });
  assert.equal(c3, 1);
  assert.match(lines.join('\n'), /unknown harness/);
});

test('attach surfaces a real spawn failure as SUMO_SPAWN_FAILED', /** Verify attach surfaces a real spawn failure as SUMO_SPAWN_FAILED. */ async () => {
  const lines = [];
  /** Implement out. */ function out(l) { return lines.push(l); }

  await seed('ses_spawn_error', { harness: 'claude-code', harnessSessionId: 'native-spawn', cwd: '/tmp/projZ' });
  fs.mkdirSync('/tmp/projZ', { recursive: true });
  writeHarnessBin('claude-code', path.join(ctx.home, 'missing-attach-binary'));

  const code = await attach(
    { sessionId: 'ses_spawn_error', json: true },
    { db: ctx.db, env: { SUMO_HOME: ctx.home }, out }
  );
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /SUMO_SPAWN_FAILED/);
});

test('attach reports invalid harness bin config without launching a native process', /** Verify attach reports invalid harness bin config without launching a native process. */ async () => {
  const lines = [];
  /** Implement out. */ function out(l) { return lines.push(l); }

  await seed('ses_cursor_bad_bin', { harness: 'cursor', harnessSessionId: 'native-cursor', cwd: '/tmp/proj-cursor-bad-bin' });
  fs.mkdirSync('/tmp/proj-cursor-bad-bin', { recursive: true });
  fs.writeFileSync(path.join(ctx.home, 'sumo.yml'), 'harness:\n  cursor:\n    bin: null\n');

  const code = await attach(
    { sessionId: 'ses_cursor_bad_bin', json: true },
    { db: ctx.db, env: { SUMO_HOME: ctx.home }, out }
  );
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /SUMO_CONFIG_INVALID/);
});

test('attach reports no native resume and keeps an explicitly configured bin through invalid sibling config', /** Verify attach reports no native resume and keeps an explicitly configured bin through invalid sibling config. */ async () => {
  const lines = [];
  /** Implement out. */ function out(l) { return lines.push(l); }

  await seed('ses_copilot_no_resume', { harness: 'copilot', harnessSessionId: 'native-copilot', cwd: '/tmp/proj-copilot-no-resume' });
  fs.mkdirSync('/tmp/proj-copilot-no-resume', { recursive: true });

  const unsupported = await attach(
    { sessionId: 'ses_copilot_no_resume', json: true },
    { db: ctx.db, env: { SUMO_HOME: ctx.home }, out }
  );
  assert.equal(unsupported, 1);
  assert.match(lines.join('\n'), /no native interactive resume/);

  await seed('ses_claude_invalid_sibling', { harness: 'claude-code', harnessSessionId: 'native-invalid-sibling', cwd: '/tmp/proj-claude-invalid-sibling' });
  fs.mkdirSync('/tmp/proj-claude-invalid-sibling', { recursive: true });
  const command = attachCommand();
  try {
    fs.writeFileSync(path.join(ctx.home, 'sumo.yml'), `harness:\n  claude-code:\n    bin: ${JSON.stringify(command.bin)}\n    mode: warp\n`);
    const code = await attach(
      { sessionId: 'ses_claude_invalid_sibling' },
      { db: ctx.db, env: { SUMO_HOME: ctx.home }, /** Implement out. */ out() {} }
    );
    assert.equal(code, 0);
    assert.deepEqual(command.read().argv, ['--resume', 'native-invalid-sibling']);
  } finally {
    command.cleanup();
  }
});
