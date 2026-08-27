/**
 * Step 1a (spec 12): the generic `steer` control op. The storage daemon holds NO harness/runtime
 * knowledge — it routes `steer` to its hosted `onSteer` handler and passes the result back verbatim.
 * A bare daemon answers SUMO_BAD_OP; a coded handler error (SUMO_RUNTIME_STARTING) is preserved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { open, SumoError } from '../src/index.mjs';
import { start } from '../src/daemon/host.mjs';

/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-steer-')); }

test('steer routes to the hosted onSteer and returns its decision verbatim', /** Verify steer routes to the hosted onSteer and returns its decision verbatim. */ async () => {
  const home = mkHome();
  /** @type {any[]} */
  const seen = [];
  const daemon = await start({
    home,
    idleShutdownMs: 0,
    /** Implement onSteer. */ async onSteer(req) {
      seen.push(req);
      return req.action === 'tool' ? { deny: 'blocked by test' } : { event: { note: 'ok' } };
    }
  });
  const db = await open({ home, autostart: false });

  const denied = await db.steer({ harness: 'claude-code', cwd: '/p/one', action: 'tool', payload: { tool: 'Bash' }, ext: { x: 1 } });
  assert.deepEqual(denied, { deny: 'blocked by test' });

  const passed = await db.steer({ harness: 'claude-code', cwd: '/p/one', action: 'prompt', payload: {} });
  assert.deepEqual(passed, { event: { note: 'ok' } });

  // the handler saw the generic, harness-agnostic request fields
  assert.equal(seen.length, 2);
  assert.deepEqual(
    { harness: seen[0].harness, cwd: seen[0].cwd, action: seen[0].action, payload: seen[0].payload, ext: seen[0].ext },
    { harness: 'claude-code', cwd: '/p/one', action: 'tool', payload: { tool: 'Bash' }, ext: { x: 1 } }
  );

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a bare storage daemon (no onSteer) answers steer with SUMO_BAD_OP', /** Verify a bare storage daemon (no onSteer) answers steer with SUMO_BAD_OP. */ async () => {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0 });
  const db = await open({ home, autostart: false });

  await assert.rejects(
    db.steer({ harness: 'claude-code', cwd: '/p', action: 'tool' }),
    /** Run the callback. */ (err) => err.code === 'SUMO_BAD_OP'
  );

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a coded onSteer error (SUMO_RUNTIME_STARTING) is preserved on the wire, not flattened', /** Verify a coded onSteer error (SUMO_RUNTIME_STARTING) is preserved on the wire, not flattened. */ async () => {
  const home = mkHome();
  const daemon = await start({
    home,
    idleShutdownMs: 0,
    /** Implement onSteer. */ async onSteer() {
      throw new SumoError({ name: 'cli', method: 'steer', code: 'SUMO_RUNTIME_STARTING', message: 'project runtime is still activating' });
    }
  });
  const db = await open({ home, autostart: false });

  await assert.rejects(
    db.steer({ harness: 'claude-code', cwd: '/p', action: 'tool' }),
    /** Run the callback. */ (err) => err.code === 'SUMO_RUNTIME_STARTING'
  );

  await db.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});
