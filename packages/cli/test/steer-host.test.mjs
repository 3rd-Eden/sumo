/**
 * Project-scoped steering host tests. These use real project `sumo.yml` files, real plugin module
 * loading, the real plugin runtime, the real orchestrator, and an isolated daemon-backed store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { key, open } from 'sumo/db';
import { createSteerHost } from '../src/steer-host.mjs';

const POLICY_PLUGIN = `
export default function scenario(sumo, options) {
  sumo.before('tool', () => ({ deny: options.reason ?? 'blocked' }));
}
scenario.sumo = { name: 'scenario' };
`;

const STATEFUL_PLUGIN = `
export default async function scenario(sumo, options) {
  const store = sumo.store('state');
  const count = (await store.get('activation-count')) ?? 0;
  await store.set('activation-count', count + 1);
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs)));
  await store.set('after-delay', true);
  sumo.before('tool', (event) => ({
    event: {
      ready: true,
      payload: event.payload,
      ext: event.ext,
      sessionId: event.sessionId,
      can: event.can
    }
  }));
}
scenario.sumo = { name: 'scenario' };
`;

const BUSY_PLUGIN = `
export default function scenario(sumo, options) {
  const store = sumo.store('state');
  sumo.before('tool', async () => {
    await new Promise((resolve) => setTimeout(resolve, Number(options.steerDelayMs ?? 0)));
    return { event: { released: true } };
  });
  sumo.destroy(async () => {
    await store.set('destroyed', true);
  });
}
scenario.sumo = { name: 'scenario' };
`;

const PUSH_PLUGIN = `
export default async function scenario(sumo) {
  const store = sumo.store('state');
  await store.set('push-result', await sumo.push('ses_missing', 'hello'));
  await store.set('push-invalid', await sumo.push('', 42));
  sumo.before('tool', () => ({ event: {} }));
}
scenario.sumo = { name: 'scenario' };
`;

const NO_HARNESS_BIN = '/nonexistent/sumo-steer-host-no-harness';
const UNAVAILABLE_HARNESSES_CONFIG = `harness:
  claude-code:
    bin: "${NO_HARNESS_BIN}"
  codex:
    bin: "${NO_HARNESS_BIN}"
  copilot:
    bin: "${NO_HARNESS_BIN}"
  cursor:
    bin: "${NO_HARNESS_BIN}"
`;

/** Implement sleep. */ function sleep(ms) {
  return new Promise(/** Run the callback. */ (resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until an observable condition is true.
 * @param {() => Promise<boolean>|boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for condition');
}

/**
 * Create a project that loads a real local plugin module through config.
 * @param {string} name
 * @param {{ source?: string, config?: string }} [opts]
 * @returns {string}
 */
function mkProject(name, { source = STATEFUL_PLUGIN, config = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sumo-sh-${name}-`));
  fs.writeFileSync(path.join(dir, 'scenario.mjs'), source);
  fs.writeFileSync(path.join(dir, 'sumo.yml'), `root: true\nuse:\n  - "./scenario.mjs"\n${config}`);
  return dir;
}

/**
 * Open an isolated daemon for one test and use the same home as the config home so global user
 * configuration cannot bleed into the project runtime.
 * @returns {Promise<{ db: any, home: string, env: NodeJS.ProcessEnv, close: () => Promise<void> }>}
 */
async function openTempDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-sh-db-'));
  const db = await open({ home, idleShutdownMs: 1000 });
  return {
    db,
    home,
    env: { SUMO_HOME: home },
    /** Implement close. */ async close() {
      await db.close();
      try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/**
 * Read the scenario plugin's real store value from the daemon.
 * @param {any} db
 * @param {string} name
 */
async function state(db, name) {
  return db.get(`kv:scenario:state:${name}`);
}

test('routes steer to the right project runtime through config-loaded plugins', /** Verify routes steer to the right project runtime through config-loaded plugins. */ async () => {
  const a = mkProject('a', {
    source: POLICY_PLUGIN,
    config: 'plugins:\n  scenario:\n    reason: "from-A"\n'
  });
  const b = mkProject('b', {
    source: POLICY_PLUGIN,
    config: 'plugins:\n  scenario:\n    reason: "from-B"\n'
  });
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, env });

  try {
    assert.equal((await host.onSteer({ harness: 'h', cwd: a, action: 'tool', payload: {} })).deny, 'from-A');
    assert.equal((await host.onSteer({ harness: 'h', cwd: b, action: 'tool', payload: {} })).deny, 'from-B');
  } finally {
    await host.dispose();
    await close();
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('two cwds in the same project share one config-loaded runtime', /** Verify two cwds in the same project share one config-loaded runtime. */ async () => {
  const proj = mkProject('shared');
  const sub = path.join(proj, 'nested');
  fs.mkdirSync(sub);
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, env });

  try {
    await host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
    await host.onSteer({ harness: 'h', cwd: sub, action: 'tool' });
    assert.equal(await state(db, 'activation-count'), 1, 'one plugin activation backs both cwds');
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('steer during activation times out, keeps the starting runtime, then succeeds', /** Verify steer during activation times out, keeps the starting runtime, then succeeds. */ async () => {
  const proj = mkProject('starting', {
    config: 'plugins:\n  scenario:\n    delayMs: 180\n'
  });
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({
    /** Implement inProcessClient. */ inProcessClient() { return db; },
    readyBudgetMs: 60,
    projectIdleMs: 140,
    env
  });

  try {
    await assert.rejects(
      host.onSteer({ harness: 'h', cwd: proj, action: 'tool' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_RUNTIME_STARTING'
    );
    let result;
    await waitFor(/** Run the callback. */ async () => {
      try {
        result = await host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
        return result?.event?.ready === true;
      } catch (err) {
        if (err?.code === 'SUMO_RUNTIME_STARTING') return false;
        throw err;
      }
    });
    assert.equal(await state(db, 'after-delay'), true);
    assert.equal(result.event.ready, true);
    assert.equal(await state(db, 'activation-count'), 1, 'the starting runtime was not evicted and rebuilt');
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('a failed project runtime is retried on the next steer', /** Verify a failed project runtime is retried on the next steer. */ async () => {
  const proj = mkProject('retry-failed');
  const { db, env, close } = await openTempDb();
  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-sh-db-retry-bad-'));
  const badDb = await open({ home: badHome, idleShutdownMs: 1000 });
  await badDb.close();

  let clientRequests = 0;
  const host = createSteerHost({
    /** Implement inProcessClient. */ inProcessClient() {
      clientRequests++;
      return clientRequests === 1 ? badDb : db;
    },
    projectIdleMs: 0,
    env
  });

  try {
    await assert.rejects(
      host.onSteer({ harness: 'h', cwd: proj, action: 'tool' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_RUNTIME_STARTING'
    );
    const result = await host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
    assert.equal(result.event.ready, true);
    assert.equal(await state(db, 'activation-count'), 1);
  } finally {
    await host.dispose();
    await close();
    try { process.kill(Number(fs.readFileSync(path.join(badHome, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
    fs.rmSync(badHome, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('idle eviction waits for in-flight steering and then runs plugin destroy', /** Verify idle eviction waits for in-flight steering and then runs plugin destroy. */ async () => {
  const proj = mkProject('busy-idle', {
    source: BUSY_PLUGIN,
    config: 'plugins:\n  scenario:\n    steerDelayMs: 140\n'
  });
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, projectIdleMs: 30, env });

  try {
    const pending = host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
    await sleep(80);
    assert.equal(await state(db, 'destroyed'), undefined, 'busy runtime is not evicted mid-steer');

    assert.equal((await pending).event.released, true);
    await waitFor(/** Run the callback. */ async () => (await state(db, 'destroyed')) === true);
    assert.equal(await state(db, 'destroyed'), true, 'plugin destroy() callback fired after idle eviction');
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('steer identity is resolved from the real session registry and correlation path', /** Verify steer identity is resolved from the real session registry and correlation path. */ async () => {
  const proj = mkProject('identity');
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, projectIdleMs: 0, env });

  try {
    await db.put(key('ses_identity'), {
      id: 'ses_identity',
      harness: 'h',
      harnessSessionId: 'native-identity',
      cwd: proj,
      state: 'running',
      observationSource: 'event-stream',
      ext: { canSendKey: true }
    });

    const correlated = await host.onSteer({
      harness: 'h',
      cwd: proj,
      action: 'tool',
      nativeSessionId: 'native-identity',
      ext: { source: 'native-hook' }
    });
    assert.equal(correlated.event.sessionId, 'ses_identity');
    assert.deepEqual(correlated.event.payload, {}, 'missing payload defaults to an object');
    assert.deepEqual(correlated.event.ext, { source: 'native-hook' });
    assert.deepEqual(correlated.event.can, {
      canSendKey: true,
      canInjectContext: true,
      observationSource: 'event-stream'
    });

    const unknownNative = await host.onSteer({ harness: 'h', cwd: proj, action: 'tool', nativeSessionId: 'native-missing' });
    assert.equal(unknownNative.event.sessionId, undefined);
    assert.deepEqual(unknownNative.event.can, {});

    await db.put(key('ses_identity_inject'), {
      id: 'ses_identity_inject',
      harness: 'h',
      harnessSessionId: 'native-inject',
      cwd: proj,
      state: 'running',
      ext: { canInjectContext: true }
    });
    const injected = await host.onSteer({ harness: 'h', cwd: proj, action: 'tool', nativeSessionId: 'native-inject' });
    assert.equal(injected.event.sessionId, 'ses_identity_inject');
    assert.deepEqual(injected.event.can, {
      canSendKey: false,
      canInjectContext: true,
      observationSource: undefined
    });
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('push facade is available to real plugins and routes through orchestrator control', /** Verify push facade is available to real plugins and routes through orchestrator control. */ async () => {
  const proj = mkProject('push', { source: PUSH_PLUGIN });
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, env });

  try {
    await host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
    assert.equal((await state(db, 'push-result'))?.ok, false);
    assert.equal((await state(db, 'push-result'))?.code, 'SUMO_SESSION_DEAD');
    assert.equal((await state(db, 'push-invalid'))?.ok, false);
    assert.equal((await state(db, 'push-invalid'))?.code, 'SUMO_CAP_UNSUPPORTED');
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('disposed host rejects new steer and session control requests', /** Verify disposed host rejects new steer and session control requests. */ async () => {
  const proj = mkProject('disposed');
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, env });

  try {
    await host.onSteer({ harness: 'h', cwd: proj, action: 'tool' });
    await host.dispose();

    await assert.rejects(
      host.onSteer({ harness: 'h', cwd: proj, action: 'tool' }),
      /** Run the callback. */ (err) => err.code === 'SUMO_RUNTIME_STARTING'
    );
    await assert.rejects(
      host.onSession({ sessionId: 'ses_after_dispose', action: 'send', cwd: proj, payload: { text: 'hi' } }),
      /** Run the callback. */ (err) => err.code === 'SUMO_RUNTIME_STARTING'
    );
  } finally {
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('session control resolves registry failures through the real daemon store', /** Verify session control resolves registry failures through the real daemon store. */ async () => {
  const proj = mkProject('session-registry', { config: UNAVAILABLE_HARNESSES_CONFIG });
  const { db, env, close } = await openTempDb();
  const host = createSteerHost({ /** Implement inProcessClient. */ inProcessClient() { return db; }, env });

  try {
    await assert.rejects(
      host.onSession({ sessionId: 'ses_missing_registry', action: 'send', payload: { text: 'hi' } }),
      /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_UNKNOWN'
    );

    await db.put(key('ses_no_cwd'), { id: 'ses_no_cwd', harness: 'codex', state: 'running' });
    await assert.rejects(
      host.onSession({ sessionId: 'ses_no_cwd', action: 'send', payload: { text: 'hi' } }),
      /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_UNKNOWN'
    );

    await db.put(key('ses_no_handle'), { id: 'ses_no_handle', harness: 'codex', cwd: proj, state: 'running' });
    await assert.rejects(
      host.onSession({ sessionId: 'ses_no_handle', action: 'send', payload: { text: 'hi' } }),
      /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_DEAD'
    );
    await assert.rejects(
      host.onSession({ sessionId: 'ses_direct_no_handle', action: 'send', cwd: proj }),
      /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_DEAD'
    );

    const topLevelSpawnCwd = await host.onSession({
      sessionId: '',
      action: 'spawn',
      cwd: proj,
      payload: { prompt: 'hello', harness: 'definitely-missing-harness' }
    });
    assert.equal(topLevelSpawnCwd.ok, false);
    assert.equal(topLevelSpawnCwd.code, 'SUMO_NO_HARNESS');

    const topLevelResumeCwd = await host.onSession({
      sessionId: '',
      action: 'resume',
      cwd: proj,
      payload: { resumeId: 'native-thread-id', harness: 'definitely-missing-harness' }
    });
    assert.equal(topLevelResumeCwd.ok, false);
    assert.equal(topLevelResumeCwd.code, 'SUMO_NO_HARNESS');

    const topLevelSpawnNoPayload = await host.onSession({ sessionId: '', action: 'spawn', cwd: proj });
    assert.equal(topLevelSpawnNoPayload.ok, false);
    assert.equal(topLevelSpawnNoPayload.code, 'SUMO_NO_HARNESS');

    const topLevelResumeNoPayload = await host.onSession({ sessionId: '', action: 'resume', cwd: proj });
    assert.equal(topLevelResumeNoPayload.ok, false);
    assert.equal(topLevelResumeNoPayload.code, 'SUMO_NO_HARNESS');

    const spawned = await host.onSession({ sessionId: '', action: 'spawn', payload: { cwd: proj, prompt: 'Reply with exactly: HOST' } });
    if (spawned.ok) {
      assert.ok(spawned.value?.sessionId?.startsWith('ses_'));
      const ended = await host.onSession({ sessionId: spawned.value.sessionId, action: 'end', cwd: proj, payload: { force: true } });
      assert.equal(ended.ok, true, JSON.stringify(ended));
    } else {
      assert.match(spawned.code ?? '', /^SUMO_/);
    }
  } finally {
    await host.dispose();
    await close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
