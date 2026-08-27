import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { open, SumoError } from '../src/index.mjs';
import { start } from '../src/daemon/host.mjs';

/** Implement mkHome. */ function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-session-'));
}

/** Implement withDaemon. */ async function withDaemon(opts, fn) {
  const home = mkHome();
  const daemon = await start({ home, idleShutdownMs: 0, ...opts });
  const db = await open({ home, autostart: false });
  try {
    await fn({ db, daemon, home });
  } finally {
    await db.close().catch(/** Handle the expected rejection. */ () => {});
    await daemon.close().catch(/** Handle the expected rejection. */ () => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('session control routes through the daemon and preserves missing-host/coded-error outcomes', /** Verify session control routes through the daemon and preserves missing-host/coded-error outcomes. */ async () => {
  const seen = [];
  await withDaemon({
    /** Implement onSession. */ async onSession(req) {
      seen.push(req);
      return { ok: true, value: { action: req.action, sessionId: req.sessionId, cwd: req.cwd } };
    }
  }, /** Run the callback. */ async ({ db }) => {
    const result = await db.session({ sessionId: 'ses_socket', action: 'send', payload: { text: 'hi' }, cwd: '/tmp/sumo-project' });
    assert.deepEqual(result, { ok: true, value: { action: 'send', sessionId: 'ses_socket', cwd: '/tmp/sumo-project' } });
  });
  assert.deepEqual(
    { sessionId: seen[0].sessionId, action: seen[0].action, payload: seen[0].payload, cwd: seen[0].cwd },
    { sessionId: 'ses_socket', action: 'send', payload: { text: 'hi' }, cwd: '/tmp/sumo-project' }
  );

  await withDaemon({}, /** Run the callback. */ async ({ db }) => {
    await assert.rejects(
      db.session({ sessionId: 'ses_absent', action: 'send' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_BAD_OP'
    );
  });

  await withDaemon({
    /** Implement onSession. */ async onSession() {
      throw new SumoError({ name: 'orchestrator', method: 'control', code: 'SUMO_SESSION_DEAD', message: 'session is gone' });
    }
  }, /** Run the callback. */ async ({ db }) => {
    await assert.rejects(
      db.session({ sessionId: 'ses_dead', action: 'send' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_DEAD'
    );
  });
});
