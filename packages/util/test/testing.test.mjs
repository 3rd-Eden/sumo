import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitUntil } from '../src/index.mjs';
import { allEvents, closeTempDb, killDaemon, openTempDb, sleep, tempDir } from '../src/testing.mjs';

test('sleep and waitUntil provide reusable polling primitives', /** Verify sleep and waitUntil provide reusable polling primitives. */ async () => {
  let ready = false;
  const timer = setTimeout(/** Run the timer callback. */ () => { ready = true; }, 20);
  const value = await waitUntil(/** Run the callback. */ () => ready && 'done', { timeoutMs: 1000 });
  clearTimeout(timer);
  assert.equal(value, 'done');
  await sleep(1);
});

test('waitUntil retries transient failures and rejects on timeout', /** Verify waitUntil retries transient failures and rejects on timeout. */ async () => {
  let attempts = 0;
  const value = await waitUntil(/** Run the callback. */ () => {
    attempts++;
    if (attempts === 1) throw new Error('not yet');
    return 'ready';
  }, { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(value, 'ready');
  await assert.rejects(
    waitUntil(/** Run the callback. */ () => false, { timeoutMs: 5, intervalMs: 1 }),
    /timeout waiting for condition/
  );
});

test('tempDir creates an isolated directory with the requested prefix', /** Verify tempDir creates an isolated directory with the requested prefix. */ () => {
  const dir = tempDir('sumo-util-test-');
  try {
    assert.equal(fs.existsSync(dir), true);
    assert.equal(path.basename(dir).startsWith('sumo-util-test-'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tempDir and killDaemon handle default and already-gone paths', /** Verify tempDir and killDaemon handle default and already-gone paths. */ () => {
  const dir = tempDir();
  try {
    assert.equal(path.basename(dir).startsWith('sumo-'), true);
    killDaemon(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openTempDb, allEvents, and closeTempDb exercise a real daemon lifecycle', /** Verify openTempDb, allEvents, and closeTempDb exercise a real daemon lifecycle. */ async () => {
  const ctx = await openTempDb({ prefix: 'sumo-util-db-', idleShutdownMs: 5000 });
  try {
    await ctx.db.append({ dedupe: 'uuid:util', type: 'util.test', payload: { ok: true } });
    const events = await allEvents(ctx.db);
    assert.equal(events.some(/** Test whether an item matches. */ (event) => event.type === 'util.test'), true);
  } finally {
    await closeTempDb(ctx);
  }
  assert.equal(fs.existsSync(ctx.home), false);
});

test('openTempDb supports the default lifecycle options', /** Verify openTempDb supports the default lifecycle options. */ async () => {
  const ctx = await openTempDb();
  try {
    assert.equal(fs.existsSync(ctx.home), true);
  } finally {
    await closeTempDb(ctx);
  }
});
