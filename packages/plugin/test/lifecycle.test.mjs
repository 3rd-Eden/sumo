import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';
import { plugin } from '../src/runtime.mjs';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** A runtime over the shared temp daemon, with isolated (empty) config. */
function createRuntime() {
  return plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
}

test('[] store() works inside a plugin body (DB is open before activation)', /** Verify [] store() works inside a plugin body (DB is open before activation). */ async () => {
  const rt = createRuntime();
  /** Implement bodyStore. */ async function bodyStore(sumo) {
    const st = sumo.store('s');
    await st.set('k', 'v-from-body'); // called DURING activation — DB must already be connected
    sumo.command('peek', /** Run the callback. */ () => st.get('k'));
  }
  rt.sumo.use(bodyStore);
  await rt.start();
  const r = await rt.invoke('peek');
  assert.deepEqual(r, { ok: true, value: 'v-from-body' });
  await rt.stop();
});

test('declared deps order activation; a missing dep skips the dependent with a diagnostic', /** Verify declared deps order activation; a missing dep skips the dependent with a diagnostic. */ async () => {
  const rt = createRuntime();
  const order = [];
  /** Implement base. */ function base(sumo) { order.push('base'); }
  base.sumo = { name: 'base' };
  /** Implement dependent. */ function dependent(sumo) { order.push('dependent'); }
  dependent.sumo = { name: 'dependent', plugins: ['base'] };
  /** Implement orphan. */ function orphan(sumo) { order.push('orphan'); }
  orphan.sumo = { name: 'orphan', plugins: ['ghost'] }; // ghost never registered

  rt.sumo.use(dependent).use(base).use(orphan); // registered out of order on purpose
  await rt.start();

  assert.deepEqual(order, ['base', 'dependent']); // base before dependent; orphan skipped
  const dep = rt.diagnostics().find(/** Find a matching item. */ (d) => d.code === 'SUMO_PLUGIN_DEP_MISSING');
  assert.ok(dep, 'expected a SUMO_PLUGIN_DEP_MISSING diagnostic');
  assert.match(dep.message, /orphan/);
  assert.match(dep.message, /ghost/);
  await rt.stop();
});

test('destroy callbacks run in reverse activation order on stop ()', /** Verify destroy callbacks run in reverse activation order on stop (). */ async () => {
  const rt = createRuntime();
  const torn = [];
  /** Implement a. */ function a(sumo) { sumo.destroy(/** Run the callback. */ () => torn.push('a')); }
  /** Implement b. */ function b(sumo) { sumo.destroy(/** Run the callback. */ () => torn.push('b')); }
  rt.sumo.use(a).use(b);
  await rt.start();
  await rt.stop();
  assert.deepEqual(torn, ['b', 'a']); // reverse of activation (a, b)
});

test('destroy callback failures become diagnostics without skipping earlier callbacks', /** Verify destroy callback failures become diagnostics without skipping earlier callbacks. */ async () => {
  const rt = createRuntime();
  const torn = [];
  /** Implement a. */ function a(sumo) { sumo.destroy(/** Run the callback. */ () => torn.push('a')); }
  a.sumo = { name: 'destroy-a' };
  /** Implement b. */ function b(sumo) { sumo.destroy(/** Run the callback. */ () => { torn.push('b'); throw new Error('destroy boom'); }); }
  b.sumo = { name: 'destroy-b' };
  rt.sumo.use(a).use(b);
  await rt.start();
  await rt.stop();

  assert.deepEqual(torn, ['b', 'a']);
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.source?.plugin === 'destroy-b' && /destroy boom/.test(d.message)));
});

test('[] an appended event reaches its observer and the watermark advances past it', /** Verify [] an appended event reaches its observer and the watermark advances past it. */ async () => {
  const rt = createRuntime();
  const seen = [];
  /** Implement observer. */ function observer(sumo) {
    sumo.on('test:done', /** Run the callback. */ (e) => { seen.push(e.payload.repo); });
  }
  rt.sumo.use(observer);
  await rt.start();

  const seq = await ctx.db.append({ dedupe: 'uuid:td1', type: 'test:done', payload: { repo: 'r1' } });
  await waitUntil(/** Run the callback. */ () => rt.watermark() >= seq);
  assert.deepEqual(seen, ['r1']);
  await rt.stop();
});

test('an observer that emit()s a derived event is delivered once and does not loop', /** Verify an observer that emit()s a derived event is delivered once and does not loop. */ async () => {
  const rt = createRuntime();
  let seenCount = 0;
  /** Implement deriver. */ function deriver(sumo) {
    sumo.on('tool.post', /** Run the callback. */ async (e) => { await e.emit('seen', { from: e.seq }); });
    sumo.on('seen', /** Run the callback. */ () => { seenCount++; });
  }
  rt.sumo.use(deriver);
  await rt.start();

  const seq = await ctx.db.append({ dedupe: 'uuid:tp1', type: 'tool.post', payload: { tool: { name: 'Bash' } } });
  await waitUntil(/** Run the callback. */ () => seenCount >= 1);
  await new Promise(/** Run the callback. */ (r) => setTimeout(r, 150)); // let any feedback settle
  assert.equal(seenCount, 1); // emitted once; no runaway loop
  assert.ok(rt.watermark() > seq);
  await rt.stop();
});

test('duplicate plugin id and anonymous plugin both throw at registration', /** Verify duplicate plugin id and anonymous plugin both throw at registration. */ () => {
  const rt = createRuntime();
  /** Implement dup. */ function dup() {}
  rt.sumo.use(dup);
  assert.throws(/** Run the callback. */ () => rt.sumo.use(dup), /already registered/);
  assert.throws(/** Run the callback. */ () => rt.sumo.use(/** Run the callback. */ () => {}), /anonymous/);
});

test('[] a config plugins.<id> slice is validated and reaches a plugin whose fn.name differs', /** Verify [] a config plugins.<id> slice is validated and reaches a plugin whose fn.name differs. */ async () => {
  const rt = plugin({
    cwd: ctx.home,
    flags: { plugins: { 'my-plugin': { repo: 'owner/x' } } },
    env: {},
    db: ctx.db
  });
  /** Implement internalName. */ function internalName(sumo, options) {
    sumo.command('opts', /** Run the callback. */ () => options);
  }
  internalName.sumo = { name: 'my-plugin', config: z.object({ repo: z.string() }) }; // id ≠ fn.name
  rt.sumo.use(internalName);
  await rt.start();
  const r = await rt.invoke('opts');
  assert.deepEqual(r, { ok: true, value: { repo: 'owner/x' } }); // keyed by .sumo.name, validated
  await rt.stop();
});

test('[] an invalid config slice marks the plugin unavailable with a diagnostic (no crash)', /** Verify [] an invalid config slice marks the plugin unavailable with a diagnostic (no crash). */ async () => {
  const rt = plugin({
    cwd: ctx.home,
    flags: { plugins: { cfg: { repo: 123 } } }, // repo must be a string
    env: {},
    db: ctx.db
  });
  /** Implement p. */ function p(sumo) {
    sumo.command('never', /** Run the callback. */ () => 'x');
  }
  p.sumo = { name: 'cfg', config: z.object({ repo: z.string() }) };
  rt.sumo.use(p);
  await rt.start();
  const r = await rt.invoke('never');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_NO_COMMAND'); // body never ran → command not registered
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_CONFIG_INVALID'));
  await rt.stop();
});

test('inline use(plugin, opts) overrides the config slice (shallow merge, inline wins)', /** Verify inline use(plugin, opts) overrides the config slice (shallow merge, inline wins). */ async () => {
  const rt = plugin({
    cwd: ctx.home,
    flags: { plugins: { merged: { a: 1, b: 2 } } },
    env: {},
    db: ctx.db
  });
  /** Implement m. */ function m(sumo, options) {
    sumo.command('opts', /** Run the callback. */ () => options);
  }
  m.sumo = { name: 'merged' }; // no schema → raw slice passthrough
  rt.sumo.use(m, { b: 99, c: 3 });
  await rt.start();
  const r = await rt.invoke('opts');
  assert.deepEqual(r.value, { a: 1, b: 99, c: 3 });
  await rt.stop();
});

test('[] a runtime dependency cycle is reported and still activates both plugins', /** Verify [] a runtime dependency cycle is reported and still activates both plugins. */ async () => {
  const rt = createRuntime();
  const ran = [];
  /** Implement pa. */ function pa() { ran.push('pa'); }
  pa.sumo = { name: 'pa', plugins: ['pb'] };
  /** Implement pb. */ function pb() { ran.push('pb'); }
  pb.sumo = { name: 'pb', plugins: ['pa'] };
  rt.sumo.use(pa).use(pb);
  await rt.start();
  assert.deepEqual(ran.sort(), ['pa', 'pb']); // cycle broken, both activated
  assert.ok(rt.diagnostics().some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_PLUGIN_CYCLE'));
  await rt.stop();
});

test('[] a runtime diamond activates the shared dependency once, before its dependents', /** Verify [] a runtime diamond activates the shared dependency once, before its dependents. */ async () => {
  const rt = createRuntime();
  const order = [];
  /** Implement base. */ function base() { order.push('base'); }
  base.sumo = { name: 'd-base' };
  /** Implement left. */ function left() { order.push('left'); }
  left.sumo = { name: 'd-left', plugins: ['d-base'] };
  /** Implement right. */ function right() { order.push('right'); }
  right.sumo = { name: 'd-right', plugins: ['d-base'] };
  /** Implement top. */ function top() { order.push('top'); }
  top.sumo = { name: 'd-top', plugins: ['d-left', 'd-right'] };
  rt.sumo.use(top).use(left).use(right).use(base); // registered out of dependency order
  await rt.start();
  assert.equal(order[0], 'base');
  assert.equal(order.at(-1), 'top');
  assert.equal(order.filter(/** Select matching items. */ (x) => x === 'base').length, 1); // activated exactly once
  await rt.stop();
});

test('string-loaded plugins reject invalid declarations without preventing unrelated activation', /** Verify string-loaded plugins reject invalid declarations without preventing unrelated activation. */ async () => {
  const rt = plugin({ cwd: import.meta.dirname, flags: {}, env: {}, db: ctx.db });
  rt.sumo.use('./fixtures/invalid-declaration-plugin.mjs');
  /** Implement healthy. */ function healthy(sumo) { sumo.command('healthy-after-invalid-declaration', /** Run the callback. */ () => 'available'); }
  healthy.sumo = { name: 'healthy-after-invalid-declaration' };
  rt.sumo.use(healthy);
  await rt.start();

  assert.ok(rt.diagnostics().some(/** Find the invalid declaration diagnostic. */ (d) => d.code === 'SUMO_PLUGIN_DECL_INVALID'));
  assert.deepEqual(await rt.invoke('healthy-after-invalid-declaration'), { ok: true, value: 'available' });
  await rt.stop();
});

test('non-object raw configuration is normalized to an empty plugin options object', /** Verify non-object raw configuration is normalized to an empty plugin options object. */ async () => {
  const rt = plugin({
    cwd: ctx.home,
    flags: { plugins: { 'raw-options': 'not-an-object' } },
    env: {},
    db: ctx.db
  });
  /** Implement rawOptions. */ function rawOptions(sumo, options) { sumo.command('raw-options', /** Run the callback. */ () => options); }
  rawOptions.sumo = { name: 'raw-options' };
  rt.sumo.use(rawOptions);
  await rt.start();

  assert.deepEqual(await rt.invoke('raw-options'), { ok: true, value: {} });
  await rt.stop();
});
