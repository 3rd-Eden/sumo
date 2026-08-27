/**
 * Regression tests for the cross-model (Codex) adversarial review of the implementation: reserved KV,
 * emit identity, observer isolation, transactional activation, async/await activation, fixpoint deps,
 * decl validation, id canonicalization, inline-opts validation, and bounded ingress shutdown.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { HttpMessenger, createHttpMessengerServer } from 'sumo/messenger/reference/http';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';
import { plugin } from '../src/runtime.mjs';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement mk. */ function mk(extra = {}) { return plugin({ cwd: import.meta.dirname, flags: {}, env: {}, db: ctx.db, ...extra }); }

// ── P0: reserved runtime KV namespace ───────────────────────────────────────────────────────────

test('[P0] a plugin id using the reserved __sumo_ prefix is rejected at registration', /** Verify [P0] a plugin id using the reserved __sumo_ prefix is rejected at registration. */ () => {
  const rt = mk();
  /** Implement evil. */ function evil() {}
  evil.sumo = { name: '__sumo_runtime__' };
  assert.throws(/** Run the callback. */ () => rt.sumo.use(evil), /reserved/);
  assert.throws(/** Run the callback. */ () => rt.sumo.use('__sumo_anything'), /reserved/);
});

// ── P1: emit() identity (per-plugin dedupe/provenance) ──────────────────────────────────────────

test('[P1] two plugins emitting the same (type,payload) from one parent produce TWO events', /** Verify [P1] two plugins emitting the same (type,payload) from one parent produce TWO events. */ async () => {
  const rt = mk();
  let seen = 0;
  /** Implement a. */ function a(sumo) { sumo.on('tool.post', /** Run the callback. */ (e) => e.emit('seen', { x: 1 })); }
  /** Implement b. */ function b(sumo) { sumo.on('tool.post', /** Run the callback. */ (e) => e.emit('seen', { x: 1 })); }
  /** Implement counter. */ function counter(sumo) { sumo.on('seen', /** Run the callback. */ () => { seen++; }); }
  rt.sumo.use(a).use(b).use(counter);
  await rt.start();

  await ctx.db.append({ dedupe: 'uuid:tp-emit', type: 'tool.post', payload: { tool: { name: 'Bash' } } });
  await waitUntil(/** Run the callback. */ () => seen >= 2);
  await new Promise(/** Run the callback. */ (r) => setTimeout(r, 120)); // settle
  assert.equal(seen, 2); // distinct plugin ids → distinct dedupe → NOT collapsed to one
  await rt.stop();
});

test('[P1] the emitted derived event records the EMITTING plugin in its dedupe/provenance', /** Verify [P1] the emitted derived event records the EMITTING plugin in its dedupe/provenance. */ async () => {
  const rt = mk();
  let derivedSeq;
  /** Implement deriver. */ function deriver(sumo) { sumo.on('tool.post', /** Run the callback. */ async (e) => { derivedSeq = await e.emit('derived', { y: 2 }); }); }
  rt.sumo.use(deriver);
  await rt.start();
  const seq = await ctx.db.append({ dedupe: 'uuid:tp-prov', type: 'tool.post', payload: {} });
  await waitUntil(/** Run the callback. */ () => derivedSeq !== undefined);
  const stored = await ctx.db.get(`evt:${String(derivedSeq).padStart(20, '0')}`);
  assert.match(stored.dedupe, /^plugin:deriver:from:/); // emitting plugin, not the runtime
  assert.equal(stored.ext.fromSeq, seq);
  await rt.stop();
});

// ── P1: observer isolation (nested mutation) ────────────────────────────────────────────────────

test('[P1] one observer mutating a nested payload field does not leak to another', /** Verify [P1] one observer mutating a nested payload field does not leak to another. */ async () => {
  const rt = mk();
  let saw;
  /** Implement mutator. */ function mutator(sumo) { sumo.on('ev', /** Run the callback. */ (e) => { e.payload.nested.v = 999; }, { priority: 200 }); }
  /** Implement reader. */ function reader(sumo) { sumo.on('ev', /** Run the callback. */ (e) => { saw = e.payload.nested.v; }); }
  rt.sumo.use(mutator).use(reader);
  await rt.start();
  await ctx.db.append({ dedupe: 'uuid:iso', type: 'ev', payload: { nested: { v: 1 } } });
  await waitUntil(/** Run the callback. */ () => saw !== undefined);
  assert.equal(saw, 1); // deep-cloned per observer → no leak
  await rt.stop();
});

// ── P1: transactional activation ────────────────────────────────────────────────────────────────

test('[P1] a plugin that throws mid-activation commits NONE of its registrations', /** Verify [P1] a plugin that throws mid-activation commits NONE of its registrations. */ async () => {
  const rt = mk();
  /** Implement partial. */ function partial(sumo) {
    sumo.command('half-registered', /** Run the callback. */ () => 'x');
    sumo.on('y', /** Run the callback. */ () => {}, { timeout: -1 }); // invalid opts → HandlerSchema.parse throws
    sumo.command('never-reached', /** Run the callback. */ () => 'y');
  }
  rt.sumo.use(partial);
  await rt.start();
  assert.equal(rt.commands().has('half-registered'), false); // rolled back
  assert.equal(rt.commands().has('never-reached'), false);
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_ACTIVATE'));
  await rt.stop();
});

// ── P1: async plugin activation is awaited (late use after await) ────────────────────────────────

test('[P1] an async plugin that use()s a child after an await still activates the child', /** Verify [P1] an async plugin that use()s a child after an await still activates the child. */ async () => {
  const rt = mk();
  /** Implement child. */ function child(sumo) { sumo.command('child-cmd', /** Run the callback. */ () => 'from-child'); }
  /** Implement asyncPack. */ async function asyncPack(sumo) {
    await Promise.resolve();
    sumo.use(child);
  }
  rt.sumo.use(asyncPack);
  await rt.start();
  const r = await rt.invoke('child-cmd');
  assert.deepEqual(r, { ok: true, value: 'from-child' });
  await rt.stop();
});

// ── P1: DeclSchema validation ─────────────────────────────────────────────────────────────────

test('[P1] a malformed plugin.sumo marker is diagnosed, not crashed', /** Verify [P1] a malformed plugin.sumo marker is diagnosed, not crashed. */ async () => {
  const rt = mk();
  /** Implement bad. */ function bad(sumo) { sumo.command('bad-cmd', /** Run the callback. */ () => 'x'); }
  bad.sumo = { plugins: 'not-an-array' }; // invalid
  rt.sumo.use({ name: 'bad', fn: bad });
  await rt.start();
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_DECL_INVALID'));
  assert.equal(rt.commands().has('bad-cmd'), false); // never activated
  await rt.stop();
});

test('[P1] plugin loader failures and unusable declared names are diagnosed', /** Verify [P1] plugin loader failures and unusable declared names are diagnosed. */ async () => {
  const missing = mk({ flags: { use: ['./fixtures/does-not-exist.mjs'] } });
  await missing.start();
  assert.ok(missing.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_LOAD' && /does-not-exist/.test(d.message)));
  await missing.stop();

  const duplicate = mk({ flags: { use: ['./fixtures/named-plugin.mjs'] } });
  /** Implement alreadyDeclared. */ function alreadyDeclared() {}
  alreadyDeclared.sumo = { name: 'declared-name' };
  duplicate.sumo.use(alreadyDeclared);
  await duplicate.start();
  assert.ok(duplicate.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_DECL_INVALID' && /duplicate/.test(d.message)));
  assert.equal(duplicate.commands().has('named-opts'), false);
  await duplicate.stop();
});

test('[P1] a plugin throwing a non-Error value during activation is diagnosed', /** Verify [P1] a plugin throwing a non-Error value during activation is diagnosed. */ async () => {
  const rt = mk();
  /** Implement throwsBareValue. */ function throwsBareValue() {
    throw 'bare activation failure';
  }
  rt.sumo.use(throwsBareValue);
  await rt.start();
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_ACTIVATE' && /bare activation failure/.test(d.message)));
  await rt.stop();
});

// ── P1: string-loaded plugin id canonicalized from .sumo.name ────────────────────────────────────

test('[P1] a string-loaded plugin is keyed by its declared name, so config reaches it', /** Verify [P1] a string-loaded plugin is keyed by its declared name, so config reaches it. */ async () => {
  const rt = mk({
    flags: { use: ['./fixtures/named-plugin.mjs'], plugins: { 'declared-name': { tag: 'hi' } } }
  });
  await rt.start();
  const r = await rt.invoke('named-opts'); // command registered by the canonical-id plugin
  assert.deepEqual(r, { ok: true, value: { tag: 'hi' } }); // config keyed by .sumo.name reached it
  await rt.stop();
});

// ── P1: programmatic unavailable dependency blocks its dependent ─────────────────────────────────

test('[P1] a dependent of a config-invalid (unavailable) plugin is skipped, not activated', /** Verify [P1] a dependent of a config-invalid (unavailable) plugin is skipped, not activated. */ async () => {
  const rt = mk({ flags: { plugins: { broken: { n: 'not-a-number' } } } });
  /** Implement broken. */ function broken(sumo) { sumo.command('broken-cmd', /** Run the callback. */ () => 'x'); }
  broken.sumo = { name: 'broken', config: z.object({ n: z.number() }) };
  /** Implement needsBroken. */ function needsBroken(sumo) { sumo.command('needs-cmd', /** Run the callback. */ () => 'y'); }
  needsBroken.sumo = { name: 'needs', plugins: ['broken'] };
  rt.sumo.use(broken).use(needsBroken);
  await rt.start();
  assert.equal(rt.commands().has('broken-cmd'), false); // unavailable (bad config)
  assert.equal(rt.commands().has('needs-cmd'), false); // dependent skipped
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_CONFIG_INVALID'));
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_DEP_MISSING'));
  await rt.stop();
});

// ── P1: inline opts are re-validated against the schema ──────────────────────────────────────────

test('[P1] inline use(plugin, opts) that violates the schema marks the plugin unavailable', /** Verify [P1] inline use(plugin, opts) that violates the schema marks the plugin unavailable. */ async () => {
  const rt = mk();
  /** Implement p. */ function p(sumo) { sumo.command('p-cmd', /** Run the callback. */ () => 'x'); }
  p.sumo = { name: 'strict', config: z.object({ n: z.number() }) };
  rt.sumo.use(p, { n: 'not-a-number' }); // inline opts violate schema
  await rt.start();
  assert.equal(rt.commands().has('p-cmd'), false);
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_CONFIG_INVALID'));
  await rt.stop();
});

test('[P1] duplicate skill registrations fail transactionally', /** Verify [P1] duplicate skill registrations fail transactionally. */ async () => {
  const rt = mk();
  /** Implement skills. */ function skills(sumo) {
    sumo.skill('triage', /** Run the callback. */ () => 'first', { description: 'first skill' });
    sumo.skill('triage', /** Run the callback. */ () => 'second', { description: 'duplicate skill' });
  }
  rt.sumo.use(skills);
  await rt.start();
  assert.equal(rt.skills().has('triage'), false, 'failed activation did not commit the first skill');
  assert.deepEqual(rt.installIntents().filter(/** Select install intents from the failed plugin. */ (intent) => intent.plugin === 'skills'), [], 'failed activation did not commit skill install intents');
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_ACTIVATE' && /triage/.test(d.message)));
  await rt.stop();
});

// ── P1: stop() cannot hang on an infinite ingress ────────────────────────────────────────────────

test('[P1] stop() returns promptly even with an infinite (signal-aware) messenger ingress', /** Verify [P1] stop() returns promptly even with an infinite (signal-aware) messenger ingress. */ async () => {
  const medium = await createHttpMessengerServer();
  const rt = mk({ config: { plugins: { 'http-reference': { baseUrl: medium.baseUrl, pollMs: 5 } } } });
  /** Implement pollingMessenger. */ function pollingMessenger(sumo) {
    sumo.messenger('http-reference', /** Run the callback. */ (mctx) => new HttpMessenger(mctx));
  }
  try {
    rt.sumo.use(pollingMessenger);
    await rt.start();
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 30)); // let ingress poll
    const started = Date.now();
    await rt.stop(); // must not hang
    assert.ok(Date.now() - started < 2500, 'stop() should return within the shutdown budget');
  } finally {
    await medium.close();
  }
});

test('[P1] event delivery drains a large FIFO burst and persists the watermark', /** Verify [P1] event delivery drains a large FIFO burst and persists the watermark. */ async () => {
  const count = 1200;
  const batch = `bulk-${Date.now()}`;
  const seen = [];
  const rt = mk();
  /** Implement bulkObserver. */ function bulkObserver(sumo) {
    sumo.on('bulk.event', /** Run the callback. */ (e) => { if (e.payload.batch === batch) seen.push(e.payload.i); });
  }
  rt.sumo.use(bulkObserver);
  await rt.start();
  for (let i = 0; i < count; i++) {
    await ctx.db.append({ dedupe: `uuid:${batch}:${i}`, type: 'bulk.event', payload: { batch, i } });
  }
  await waitUntil(/** Run the callback. */ () => seen.length === count, { timeoutMs: 10_000 });
  assert.deepEqual(seen, Array.from({ length: count }, /** Run the callback. */ (_, i) => i));
  await rt.stop();

  const replayed = [];
  const rt2 = mk();
  /** Implement replayObserver. */ function replayObserver(sumo) {
    sumo.on('bulk.event', /** Run the callback. */ (e) => { if (e.payload.batch === batch) replayed.push(e.payload.i); });
  }
  rt2.sumo.use(replayObserver);
  await rt2.start();
  await new Promise(/** Run the callback. */ (r) => setTimeout(r, 150));
  assert.deepEqual(replayed, [], 'drained backlog is skipped after restart by the persisted watermark');

  await ctx.db.append({ dedupe: `uuid:${batch}:next`, type: 'bulk.event', payload: { batch, i: count } });
  await waitUntil(/** Run the callback. */ () => replayed.length === 1, { timeoutMs: 3000 });
  assert.deepEqual(replayed, [count]);
  await rt2.stop();
});
