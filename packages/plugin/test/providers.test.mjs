import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providers } from '../src/providers.mjs';
import { Codex, Copilot } from 'sumo/harness';
import { assertAvailable } from '../../harness/test/_live.mjs';
import { HttpMessenger, createHttpMessengerServer } from 'sumo/messenger/reference/http';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

const NO_CODEX_BIN = '/nonexistent/sumo-codex-provider';

/** Implement providerWithHarnessConfig. */ function providerWithHarnessConfig(rootHarness, perHarness = {}) {
  return providers({
    /** Implement configFor. */ configFor(name) {
      if (name === '') return rootHarness ? { harness: rootHarness } : {};
      return perHarness[name] ?? {};
    }
  });
}

/** Implement registerCodexHarness. */ function registerCodexHarness(p, name) {
  p.harness(name, /** Run the callback. */ (hctx) => new Codex(hctx));
}

/** Implement registerCopilotHarness. */ function registerCopilotHarness(p, name) {
  p.harness(name, /** Run the callback. */ (hctx) => new Copilot(hctx));
}

/** Implement endSession. */ async function endSession(session) {
  await session.end({ force: true });
  await session.done();
}

test('run() with no harness returns SUMO_NO_HARNESS — no crash, no fake', /** Verify run() with no harness returns SUMO_NO_HARNESS — no crash, no fake. */ async () => {
  const p = providers();
  const r = await p.run('do the thing');
  assert.deepEqual(r, { ok: false, code: 'SUMO_NO_HARNESS', reason: 'no harness registered' });
  assert.equal(p.hasHarness(), false);
});

test('run() with a named-but-absent harness returns SUMO_NO_HARNESS', /** Verify run() with a named-but-absent harness returns SUMO_NO_HARNESS. */ async () => {
  const p = providers();
  registerCodexHarness(p, 'codex');
  const r = await p.run('x', { harness: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_NO_HARNESS');
});

test('run() falls back from an unavailable configured default to the first available real Codex fallback', { timeout: 150_000 }, /** Verify run() falls back from an unavailable configured default to the first available real Codex fallback. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(
    { default: 'primary', fallback: ['fallback'] },
    { primary: { bin: NO_CODEX_BIN }, fallback: cfg }
  );
  registerCodexHarness(p, 'primary');
  registerCodexHarness(p, 'fallback');

  const r = await p.run('Reply with exactly: OK');
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('run() with explicit unavailable harness does not fallback unless fallback is configured', /** Verify run() with explicit unavailable harness does not fallback unless fallback is configured. */ async () => {
  const p = providerWithHarnessConfig(undefined, { primary: { bin: NO_CODEX_BIN } });
  registerCodexHarness(p, 'primary');
  registerCodexHarness(p, 'fallback');

  const r = await p.run('x', { harness: 'primary' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_NO_HARNESS');
  assert.match(r.reason, /primary: .*ENOENT/);
});

test('run() with explicit unavailable harness falls back when real Codex fallback is configured', { timeout: 150_000 }, /** Verify run() with explicit unavailable harness falls back when real Codex fallback is configured. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(
    { fallback: ['fallback'] },
    { primary: { bin: NO_CODEX_BIN }, fallback: cfg }
  );
  registerCodexHarness(p, 'primary');
  registerCodexHarness(p, 'fallback');

  const r = await p.run('Reply with exactly: OK', { harness: 'primary' });
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('run() falls back from an unavailable configured default to the first available real Copilot fallback', { timeout: 150_000 }, /** Verify run() falls back from an unavailable configured default to the first available real Copilot fallback. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(
    { default: 'primary', fallback: ['fallback'] },
    { primary: { bin: NO_CODEX_BIN }, fallback: cfg }
  );
  registerCopilotHarness(p, 'primary');
  registerCopilotHarness(p, 'fallback');

  const r = await p.run('Reply with exactly: OK');
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('run() with explicit unavailable harness falls back when real Copilot fallback is configured', { timeout: 150_000 }, /** Verify run() with explicit unavailable harness falls back when real Copilot fallback is configured. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(
    { fallback: ['fallback'] },
    { primary: { bin: NO_CODEX_BIN }, fallback: cfg }
  );
  registerCopilotHarness(p, 'primary');
  registerCopilotHarness(p, 'fallback');

  const r = await p.run('Reply with exactly: OK', { harness: 'primary' });
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('run() does not cross-fallback while resuming', /** Verify run() does not cross-fallback while resuming. */ async () => {
  const p = providerWithHarnessConfig(
    { default: 'primary', fallback: ['fallback'] },
    { primary: { bin: NO_CODEX_BIN } }
  );
  registerCodexHarness(p, 'primary');
  registerCodexHarness(p, 'fallback');

  const r = await p.run('x', { resume: 'native-session-id' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_NO_HARNESS');
  assert.match(r.reason, /primary: .*ENOENT/);
});

test('run() resume without an explicit harness can use the single registered adapter candidate', /** Verify run() resume without an explicit harness can use the single registered adapter candidate. */ async () => {
  const p = providerWithHarnessConfig(undefined, { codex: { bin: NO_CODEX_BIN } });
  registerCodexHarness(p, 'codex');

  const r = await p.run('x', { resume: 'native-session-id' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_NO_HARNESS');
  assert.match(r.reason, /codex: .*ENOENT/);
});

test('a registered real Codex harness builds a live Session', { timeout: 150_000 }, /** Verify a registered real Codex harness builds a live Session. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(undefined, { codex: cfg });
  registerCodexHarness(p, 'codex');
  const r = await p.run('Reply with exactly: OK', { harness: 'codex' });
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('a registered real Copilot harness builds a live Session', { timeout: 150_000 }, /** Verify a registered real Copilot harness builds a live Session. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  const p = providerWithHarnessConfig(undefined, { copilot: cfg });
  registerCopilotHarness(p, 'copilot');
  const r = await p.run('Reply with exactly: OK', { harness: 'copilot' });
  assert.equal(r.ok, true);
  await endSession(r.value);
});

test('duplicate harness / messenger names throw (programmer error)', /** Verify duplicate harness / messenger names throw (programmer error). */ () => {
  const p = providers();
  p.harness('h', /** Run the callback. */ (hctx) => new Codex(hctx));
  assert.throws(/** Run the callback. */ () => p.harness('h', /** Run the callback. */ (hctx) => new Codex(hctx)), /already registered/);
  p.messenger('m', /** Run the callback. */ (mctx) => new HttpMessenger({ ...mctx, config: { baseUrl: 'http://127.0.0.1:1' } }));
  assert.throws(/** Run the callback. */ () => p.messenger('m', /** Run the callback. */ (mctx) => new HttpMessenger({ ...mctx, config: { baseUrl: 'http://127.0.0.1:1' } })), /already registered/);
});

test('a non-function impl throws', /** Verify a non-function impl throws. */ () => {
  const p = providers();
  assert.throws(/** Run the callback. */ () => p.harness('h', /** @type {any} */ ({})), /factory function/);
});

test('the messenger build-context (mctx) carries db + name (so the base can append events)', /** Verify the messenger build-context (mctx) carries db + name (so the base can append events). */ async () => {
  const medium = await createHttpMessengerServer();
  const ctx = await openTempDb();
  // The daemon client is opaque to providers; assert it is threaded through to mctx by identity (the
  // harness branch already does this — providers.mjs — this proves the messenger branch matches).
  const db = ctx.db;
  const p = providers({ db, /** Implement configFor. */ configFor(name) { return name === 'http-reference' ? { baseUrl: medium.baseUrl } : {}; } });
  let seen;
  try {
    p.messenger('http-reference', /** Run the callback. */ (mctx) => { seen = mctx; return new HttpMessenger(mctx); });
    p.instantiateMessengers();
    assert.equal(seen.db, db, 'mctx.db is the injected daemon client');
    assert.equal(seen.name, 'http-reference', 'mctx.name is the registration name');
    assert.equal(typeof seen.work, 'function');
    assert.equal(typeof seen.store, 'object');
  } finally {
    await medium.close();
    await closeTempDb(ctx);
  }
});

test('a registered reference HTTP messenger produces a work object with bound reply', /** Verify a registered reference HTTP messenger produces a work object with bound reply. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'w1', title: 'fix bug', ext: { issue: 7 } });
  const p = providers({ /** Implement configFor. */ configFor(name) { return name === 'http-reference' ? { baseUrl: medium.baseUrl } : {}; } });
  try {
    p.messenger('http-reference', /** Run the callback. */ (mctx) => new HttpMessenger(mctx));

    const [{ name, adapter }] = p.instantiateMessengers();
    assert.equal(name, 'http-reference');
    const works = [];
    for await (const w of adapter.ingress()) works.push(w);
    assert.equal(works.length, 1);
    assert.ok(works[0].id.startsWith('work_'));
    assert.equal(works[0].title, 'fix bug');
    assert.equal(works[0].can.reply, true);
    await works[0].reply('done'); // bound through the HTTP medium
    assert.deepEqual(medium.getWork('w1').replies.map(/** Map one item. */ (r) => r.text), ['done']);
  } finally {
    await medium.close();
  }
});

test('provider public edges use real adapters and reference messenger defaults', /** Verify provider public edges use real adapters and reference messenger defaults. */ async () => {
  const medium = await createHttpMessengerServer();
  const ctx = await openTempDb();
  const db = ctx.db;
  const p = providers({
    db,
    signal: AbortSignal.abort(),
    /** Implement configFor. */ configFor(name) {
      if (name === '') return { harness: { default: 42, fallback: ['missing', '', 'missing', 'codex'] } };
      if (name === 'codex') return { bin: NO_CODEX_BIN };
      if (name === 'http-reference') return { baseUrl: medium.baseUrl };
      return {};
    }
  });

  try {
    assert.equal(p.hasMessenger(), false);
    assert.throws(/** Run the callback. */ () => p.harness('', /** Run the callback. */ (hctx) => new Codex(hctx)), /non-empty name/);
    assert.throws(/** Run the callback. */ () => p.messenger('bad', /** @type {any} */ ({})), /factory function/);

    let messengerCtx;
    p.harness('codex', /** Run the callback. */ (hctx) => new Codex(hctx));
    p.messenger('http-reference', /** Run the callback. */ (mctx) => {
      messengerCtx = mctx;
      return new HttpMessenger(mctx);
    });
    assert.equal(p.hasMessenger(), true);
    assert.equal(p.hasHarnessName('codex'), true);
    assert.equal(p.hasMessengerName('http-reference'), true);
    p.instantiateMessengers();

    const exactMissing = await p.run('x', { harness: 'missing', __sumoExactHarness: true });
    assert.equal(exactMissing.ok, false);
    assert.match(exactMissing.reason, /missing/);

    const configured = await p.run('x');
    assert.equal(configured.ok, false);
    assert.match(configured.reason, /missing/);
    assert.match(configured.reason, /codex/);
    assert.match(configured.reason, /ENOENT/);

    assert.equal(messengerCtx.db, db);
    assert.equal(messengerCtx.signal.aborted, true);
    assert.deepEqual(messengerCtx.message({ text: 'hello' }), { text: 'hello' });
    const thread = messengerCtx.thread({ id: 'thread-1' });
    assert.deepEqual(await thread.react('thumbs-up'), { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'reactions unsupported' });
  } finally {
    await medium.close();
    await closeTempDb(ctx);
  }
});
