/**
 * The privileged extension seams the orchestrator builds on: `extendFacade` (extra `sumo` verbs),
 * `wrapRun` (spawn interception), and the engine's `'*'` all-events observer. Real daemon, no mocks.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SumoError } from 'sumo/error';
import { Codex } from 'sumo/harness';
import { HttpMessenger, createHttpMessengerServer } from 'sumo/messenger/reference/http';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';
import { plugin } from '../src/runtime.mjs';
import { fail } from '../src/schema.mjs';

let ctx;
const NO_HARNESS_BIN = '/nonexistent/sumo-no-harness';
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement createRuntime. */ function createRuntime() {
  return plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        'claude-code': { bin: NO_HARNESS_BIN },
        codex: { bin: NO_HARNESS_BIN },
        copilot: { bin: NO_HARNESS_BIN },
        cursor: { bin: NO_HARNESS_BIN }
      }
    }
  });
}

test('extendFacade adds a verb to a plugin facade, bound with the calling pluginId', /** Verify extendFacade adds a verb to a plugin facade, bound with the calling pluginId. */ async () => {
  const rt = createRuntime();
  const calls = [];
  rt.extendFacade('surface', /** Run the callback. */ (pluginId, e) => { calls.push([pluginId, e]); return { ok: true }; });

  let ret;
  /** Implement p. */ function p(sumo) { ret = sumo.surface({ reason: 'x' }); }
  p.sumo = { name: 'p1' };
  rt.sumo.use(p);
  await rt.start();

  assert.deepEqual(calls, [['p1', { reason: 'x' }]]);
  assert.deepEqual(ret, { ok: true }); // non-staged action returns the handler's value immediately
  await rt.stop();
});

test('extendFacade rejects built-in collisions, dup verbs, and post-start registration', /** Verify extendFacade rejects built-in collisions, dup verbs, and post-start registration. */ async () => {
  const rt = createRuntime();
  assert.throws(/** Run the callback. */ () => rt.extendFacade('run', /** Run the callback. */ () => {}), /collides with a built-in/);
  assert.throws(/** Run the callback. */ () => rt.extendFacade('on', /** Run the callback. */ () => {}), /collides with a built-in/);
  rt.extendFacade('modify', /** Run the callback. */ () => {});
  assert.throws(/** Run the callback. */ () => rt.extendFacade('modify', /** Run the callback. */ () => {}), /already registered/);
  assert.throws(/** Run the callback. */ () => rt.extendFacade('health', 'not-a-fn'), /must be a function/);
  await rt.start();
  assert.throws(/** Run the callback. */ () => rt.extendFacade('late', /** Run the callback. */ () => {}), /before start/);
  await rt.stop();
});

test('wrapRun rejects invalid and late hooks', /** Verify wrapRun rejects invalid and late hooks. */ async () => {
  const rt = createRuntime();
  assert.throws(/** Run the callback. */ () => rt.wrapRun('not-a-fn'), /hook must be a function/);
  await rt.start();
  assert.throws(/** Run the callback. */ () => rt.wrapRun(/** Run the callback. */ () => {}), /before start/);
  await rt.stop();
});

test('a staged verb commits on success and rolls back when activation throws', /** Verify a staged verb commits on success and rolls back when activation throws. */ async () => {
  const rt = createRuntime();
  const committed = [];
  rt.extendFacade('guard', /** Run the callback. */ (pluginId, name) => committed.push(`${pluginId}:${name}`), { staged: true });

  /** Implement good. */ function good(sumo) { sumo.guard('rate'); }
  good.sumo = { name: 'good' };
  /** Implement bad. */ function bad(sumo) { sumo.guard('caps'); throw new Error('boom'); }
  bad.sumo = { name: 'bad' };
  rt.sumo.use(good).use(bad);
  await rt.start();

  // good's staged effect committed; bad's was discarded with the failed activation (parity with `on`)
  assert.deepEqual(committed, ['good:rate']);
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_ACTIVATE' && /bad/.test(d.message)));
  await rt.stop();
});

test('runtime harness introspection handles real Codex diagnostics and first-party adapters', /** Verify runtime harness introspection handles real Codex diagnostics and first-party adapters. */ async () => {
  const rt = createRuntime();
  /** Implement harnesses. */ function harnesses(sumo) {
    sumo.harness('codex-alias', /** Run the callback. */ (hctx) => new Codex(hctx));
  }
  harnesses.sumo = { name: 'harness-introspection' };
  rt.sumo.use(harnesses);
  await rt.start();

  const rows = rt.listHarnesses();
  assert.ok(rows.some(/** Test whether an item matches. */ (h) => h.id === 'codex' && h.providers.includes('openai')));
  assert.ok(rows.some(/** Test whether an item matches. */ (h) => h.id === 'codex-alias' && h.providers.includes('openai')));
  assert.equal(rt.diagnoseFor('missing', 'invalid model name'), null);
  assert.deepEqual(rt.diagnoseFor('codex', 'invalid model name'), {
    category: 'fatal',
    reasoning: 'Codex CLI received invalid model name — API key may not support the requested model'
  });
  assert.equal(rt.diagnoseFor('codex', 'plain output'), null);
  assert.equal(rt.diagnoseFor('cursor', 'invalid model name'), null);
  await rt.stop();
});

test('root facade registers immediate skills, install intents, destroy callbacks and emitted events', /** Verify root facade registers immediate skills, install intents, destroy callbacks and emitted events. */ async () => {
  const rt = createRuntime();
  const destroyed = [];
  rt.sumo.skill('root-skill', /** Run the callback. */ () => 'skill-result', { title: 'Root skill' });
  rt.sumo.skill('result-skill', /** Run the callback. */ () => fail('SUMO_EXPECTED', 'expected skill outcome'), { source: './skills/result.md' });
  rt.sumo.skill('failing-skill', /** Run the callback. */ () => { throw new Error('skill boom'); });
  rt.sumo.skill('string-failure-skill', /** Run the callback. */ () => { throw 'string skill boom'; });
  const defaultStore = rt.sumo.store();
  await defaultStore.set('default-store-key', 'default-store-value');
  rt.sumo.install({ hook: { harness: 'codex' } });
  rt.sumo.destroy(/** Run the callback. */ () => destroyed.push('root'));
  const seq = await rt.sumo.emit('root.prestart', { from: 'root' }, { dedupe: 'root-prestart', sessionId: 'ses_root' });
  const randomSeq = await rt.sumo.emit('root.random', { from: 'root' });

  assert.equal(typeof seq, 'number');
  assert.equal(typeof randomSeq, 'number');
  assert.equal(await rt.start(), rt);
  assert.deepEqual(await rt.sumo.skill.run('root-skill', { from: 'test' }), {
    ok: true,
    value: 'skill-result'
  });
  assert.deepEqual(await rt.sumo.skill.run('missing-skill'), {
    ok: false,
    code: 'SUMO_NO_SKILL',
    reason: "no skill registered with name 'missing-skill'"
  });
  assert.deepEqual(await rt.sumo.skill.run('failing-skill'), {
    ok: false,
    code: 'SUMO_SKILL_FAILED',
    reason: "skill 'failing-skill' failed: skill boom"
  });
  assert.deepEqual(await rt.sumo.skill.run('result-skill'), {
    ok: false,
    code: 'SUMO_EXPECTED',
    reason: 'expected skill outcome'
  });
  assert.deepEqual(await rt.sumo.skill.run('string-failure-skill'), {
    ok: false,
    code: 'SUMO_SKILL_FAILED',
    reason: "skill 'string-failure-skill' failed: string skill boom"
  });
  assert.ok(rt.diagnostics().some(/** Find the skill failure diagnostic. */ (d) => d.code === 'SUMO_INTERNAL' && d.source?.plugin === 'skill:failing-skill'));
  assert.equal(await rt.start(), rt);
  await rt.stop();

  assert.equal(rt.skills().get('root-skill').plugin, 'root');
  assert.equal(await defaultStore.get('default-store-key'), 'default-store-value');
  assert.deepEqual(
    rt.installIntents().find(/** Find the skill install intent. */ (intent) => intent.plugin === 'root' && intent.spec.skills)?.spec.skills,
    [{ name: 'root-skill' }]
  );
  assert.ok(rt.installIntents().some(/** Test whether an item matches. */ (intent) => intent.plugin === 'root' && intent.spec.hook?.harness === 'codex'));
  assert.deepEqual(
    rt.installIntents().find(/** Find the sourced skill intent. */ (intent) => intent.spec.skills?.[0]?.name === 'result-skill')?.spec.skills,
    [{ name: 'result-skill', source: './skills/result.md' }]
  );
  assert.deepEqual(destroyed, ['root']);
  const random = await ctx.db.get(`evt:${String(randomSeq).padStart(20, '0')}`);
  assert.match(random.dedupe, /^plugin:root:emit:root\.random:/);
  assert.equal(random.sessionId, undefined);
});

test('runtime tolerates unavailable module and harness factories through its public diagnostics API', /** Verify runtime tolerates unavailable module and harness factories through its public diagnostics API. */ async () => {
  const rt = createRuntime();
  /** Implement brokenHarness. */ function brokenHarness(sumo) {
    sumo.harness('broken-harness', /** Run the callback. */ () => { throw new Error('factory unavailable'); });
  }
  brokenHarness.sumo = { name: 'broken-harness-plugin' };
  rt.sumo.use('./not-a-plugin-module.mjs').use(brokenHarness);
  await rt.start();

  assert.ok(rt.diagnostics().some(/** Find the load diagnostic. */ (d) => d.code === 'SUMO_PLUGIN_LOAD'));
  assert.deepEqual(rt.listHarnesses().find(/** Find the broken harness. */ (h) => h.id === 'broken-harness'), {
    id: 'broken-harness',
    providers: []
  });
  assert.equal(rt.diagnoseFor('broken-harness', 'anything'), null);
  await rt.stop();
});

test('root provider registration is rejected outside activation and staged provider duplicates roll back', /** Verify root provider registration is rejected outside activation and staged provider duplicates roll back. */ async () => {
  const rt = createRuntime();
  assert.throws(/** Run the callback. */ () => rt.sumo.harness('root-codex', /** Run the callback. */ (hctx) => new Codex(hctx)), /can only be called during plugin activation/);

  /** Implement duplicateProviders. */ function duplicateProviders(sumo) {
    sumo.harness('dup-codex', /** Run the callback. */ (hctx) => new Codex(hctx));
    sumo.harness('dup-codex', /** Run the callback. */ (hctx) => new Codex(hctx));
  }
  duplicateProviders.sumo = { name: 'duplicate-providers' };
  rt.sumo.use(duplicateProviders);
  await rt.start();

  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_ACTIVATE' && /duplicate-providers/.test(d.message)));
  assert.equal(rt.listHarnesses().some(/** Test whether an item matches. */ (h) => h.id === 'dup-codex'), false);
  await rt.stop();
});

test('wrapRun intercepts sumo.run; unset it falls through to provider selection', /** Verify wrapRun intercepts sumo.run; unset it falls through to provider selection. */ async () => {
  // intercept
  const rt1 = createRuntime();
  const seen = [];
  rt1.wrapRun(/** Run the callback. */ (prompt, opts, baseRun, pluginId) => {
    seen.push([prompt, pluginId]);
    return baseRun(prompt, opts);
  });
  assert.throws(/** Run the callback. */ () => rt1.wrapRun(/** Run the callback. */ () => {}), /already registered/); // second hook rejected (pre-start)
  let intercepted;
  /** Implement p1. */ function p1(sumo) {
    return (/** Run the callback. */ async () => { intercepted = await sumo.run('hi'); })();
  }
  p1.sumo = { name: 'caller' };
  rt1.sumo.use(p1);
  await rt1.start();
  assert.deepEqual(seen, [['hi', 'caller']]);
  assert.equal(intercepted.ok, false);
  assert.equal(intercepted.code, 'SUMO_NO_HARNESS');
  await rt1.stop();

  // fall-through: no hook → bare provider spawn, which fails loudly with no harness registered
  const rt2 = createRuntime();
  let fell;
  /** Implement p2. */ function p2(sumo) { return (/** Run the callback. */ async () => { fell = await sumo.run('hi'); })(); }
  p2.sumo = { name: 'caller2' };
  rt2.sumo.use(p2);
  await rt2.start();
  assert.equal(fell.ok, false);
  assert.equal(fell.code, 'SUMO_NO_HARNESS');
  await rt2.stop();
});

test("on('*') receives an event of an otherwise-unobserved type", /** Verify on('*') receives an event of an otherwise-unobserved type. */ async () => {
  const rt = createRuntime();
  const all = [];
  /** Implement watcher. */ function watcher(sumo) { sumo.on('*', /** Run the callback. */ (e) => { all.push(e.type); }); }
  rt.sumo.use(watcher);
  await rt.start();

  const seq = await ctx.db.append({ dedupe: 'uuid:wild1', type: 'weird.unobserved', payload: { a: 1 } });
  await waitUntil(/** Run the callback. */ () => all.includes('weird.unobserved'));
  assert.ok(rt.watermark() >= seq);
  await rt.stop();
});

test('runtime records real SumoError diagnostics and messenger ingress failures', /** Verify runtime records real SumoError diagnostics and messenger ingress failures. */ async () => {
  const medium = await createHttpMessengerServer();
  const baseUrl = medium.baseUrl;
  await medium.close();

  const rt = createRuntime();
  /** Implement watcher. */ function watcher(sumo) {
    sumo.on('diagnostic.sumo-error', /** Run the callback. */ () => {
      throw new SumoError({ name: 'plugin', method: 'observer', code: 'SUMO_TEST_DIAGNOSTIC', message: 'structured observer failure' });
    });
  }
  watcher.sumo = { name: 'diagnostic-watcher' };
  /** Implement brokenIngress. */ function brokenIngress(sumo) {
    sumo.messenger('closed-http-reference', /** Run the callback. */ (mctx) => new HttpMessenger({ ...mctx, config: { baseUrl } }));
  }
  brokenIngress.sumo = { name: 'closed-http-reference-plugin' };

  rt.sumo.use(watcher).use(brokenIngress);
  await rt.start();
  const seq = await ctx.db.append({ dedupe: 'diagnostic-sumo-error', type: 'diagnostic.sumo-error', payload: {} });
  await waitUntil(/** Run the callback. */ () => rt.watermark() >= seq);
  await rt.drainIngress();

  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_TEST_DIAGNOSTIC' && d.method === 'observer'));
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.source?.plugin === 'ingress'));
  await rt.stop();
});

test('runtime wraps plain observer failures as diagnostics with event provenance', /** Verify runtime wraps plain observer failures as diagnostics with event provenance. */ async () => {
  const rt = createRuntime();
  /** Implement watcher. */ function watcher(sumo) {
    sumo.on('diagnostic.plain-observer', /** Run the callback. */ () => {
      throw 'plain observer failure';
    });
  }
  watcher.sumo = { name: 'plain-observer-watcher' };

  rt.sumo.use(watcher);
  await rt.start();
  const seq = await ctx.db.append({ dedupe: 'plain-observer-failure', type: 'diagnostic.plain-observer', payload: {} });
  await waitUntil(/** Run the callback. */ () => rt.watermark() >= seq);

  const diagnostic = rt.diagnostics().find(/** Find a matching item. */ (d) => d.code === 'SUMO_INTERNAL' && /plain observer failure/.test(d.message));
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.source, { plugin: 'diagnostic.plain-observer' });
  await rt.stop();
});
