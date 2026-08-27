/**
 * The generic daemon-owned service lifecycle (the host for the always-on ingestion service): the daemon must
 * `start(db)` the service after storage is listening and `stop()` it BEFORE the DB closes — on every
 * close path — so a long-lived worker never writes to a closed DB. Real daemon, injected lifecycle
 * probe service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { start } from 'sumo/db/daemon';

/** Implement tempDaemon. */ async function tempDaemon(service) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-service-'));
  const daemon = await start({ home, idleShutdownMs: 0, service });
  return { daemon, home, /** Implement cleanup. */ cleanup() { return fs.rmSync(home, { recursive: true, force: true }); } };
}

test('service.start runs after listen; service.stop runs while the DB is still open', /** Verify service.start runs after listen; service.stop runs while the DB is still open. */ async () => {
  const events = [];
  let clientAtStop;
  const service = {
    /** Implement start. */ async start(db) { events.push('start'); clientAtStop = db; },
    /** Implement stop. */ async stop() {
      events.push('stop');
      // The DB must still be writable here — the daemon stops the service before closing storage.
      try { await clientAtStop.put('service-probe', { ok: 1 }); events.push('db-open-at-stop'); }
      catch { events.push('db-closed-at-stop'); }
    }
  };

  const { daemon, cleanup } = await tempDaemon(service);
  try {
    assert.deepEqual(events, ['start'], 'start fired once the daemon was listening');
    await daemon.close();
    assert.deepEqual(events, ['start', 'stop', 'db-open-at-stop'], 'stop ran before the DB closed');
  } finally {
    cleanup();
  }
});

test('a daemon with no service still starts and closes cleanly', /** Verify a daemon with no service still starts and closes cleanly. */ async () => {
  const { daemon, cleanup } = await tempDaemon(undefined);
  try {
    await daemon.close();
  } finally {
    cleanup();
  }
});
