/**
 * The capability layer on the runtime: rich `command(create(...))` registration, the
 * machine-readable `capabilities()` catalog, surface gating, and back-compat of the thin
 * `command(name, fn, schema?)` form. Exercised against the REAL daemon-backed runtime (§5).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { plugin } from '../src/runtime.mjs';
import { create } from 'sumo/capability';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement createRuntime. */ function createRuntime() {
  return plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
}

test('rich capability: invoke validates input and returns the raw value wrapped in ok()', /** Verify rich capability: invoke validates input and returns the raw value wrapped in ok(). */ async () => {
  const rt = createRuntime();
  /** Implement greeter. */ function greeter(sumo) {
    sumo.command(
      create({
        name: 'greet',
        title: 'Greet',
        description: 'say hello',
        inputSchema: z.object({ who: z.string() }),
        outputSchema: z.object({ hello: z.string() }),
        /** Implement exec. */ exec(input) { return ({ hello: input.who }); }
      })
    );
  }
  rt.sumo.use(greeter);
  await rt.start();
  try {
    assert.deepEqual(await rt.invoke('greet', { who: 'ada' }), { ok: true, value: { hello: 'ada' } });
    const bad = await rt.invoke('greet', { who: 42 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'SUMO_COMMAND_INPUT_INVALID');
  } finally {
    await rt.stop();
  }
});

test('capabilities() catalog projects each registered capability with JSON-Schema input + plugin tag', /** Verify capabilities() catalog projects each registered capability with JSON-Schema input + plugin tag. */ async () => {
  const rt = createRuntime();
  /** Implement demo. */ function demo(sumo) {
    sumo.command(
      create({
        name: 'mk',
        title: 'Make',
        description: 'make a thing',
        inputSchema: z.object({ count: z.number().optional() }),
        surfaces: ['cli', 'programmatic'],
        /** Implement exec. */ exec() { return ({}); }
      })
    );
  }
  demo.sumo = { name: 'demo' };
  rt.sumo.use(demo);
  await rt.start();
  try {
    const cat = rt.capabilities();
    const mk = cat.find(/** Find a matching item. */ (c) => c.name === 'mk');
    assert.ok(mk, 'mk is in the catalog');
    assert.equal(mk.plugin, 'demo');
    assert.equal(mk.title, 'Make');
    assert.deepEqual(mk.surfaces, ['cli', 'programmatic']);
    assert.equal(mk.inputSchema.type, 'object');
    assert.equal(mk.inputSchema.properties.count.type, 'number');
  } finally {
    await rt.stop();
  }
});

test('surface gating: a programmatic-only capability rejects cli/mcp via SUMO_SURFACE_UNSUPPORTED', /** Verify surface gating: a programmatic-only capability rejects cli/mcp via SUMO_SURFACE_UNSUPPORTED. */ async () => {
  const rt = createRuntime();
  /** Implement vault. */ function vault(sumo) {
    sumo.command(
      create({
        name: 'secret',
        title: 'Secret',
        description: 'internal only',
        surfaces: ['programmatic'],
        /** Implement exec. */ exec() { return 'ok'; }
      })
    );
  }
  rt.sumo.use(vault);
  await rt.start();
  try {
    assert.deepEqual(await rt.invoke('secret'), { ok: true, value: 'ok' }); // default surface = programmatic
    const viaCli = await rt.invoke('secret', {}, { surface: 'cli' });
    assert.equal(viaCli.ok, false);
    assert.equal(viaCli.code, 'SUMO_SURFACE_UNSUPPORTED');
    const viaMcp = await rt.invoke('secret', {}, { surface: 'mcp' });
    assert.equal(viaMcp.code, 'SUMO_SURFACE_UNSUPPORTED');
  } finally {
    await rt.stop();
  }
});

test('thin command(name, fn) with no schema still passes args through unvalidated (back-compat)', /** Verify thin command(name, fn) with no schema still passes args through unvalidated (back-compat). */ async () => {
  const rt = createRuntime();
  /** Implement echoer. */ function echoer(sumo) {
    sumo.command('echo', /** Run the callback. */ (args) => ({ echoed: args }));
  }
  rt.sumo.use(echoer);
  await rt.start();
  try {
    assert.deepEqual(await rt.invoke('echo', { a: 1, b: 'x' }), { ok: true, value: { echoed: { a: 1, b: 'x' } } });
    // a thin command defaults to all surfaces, so the catalog lists it everywhere
    const echo = rt.capabilities().find(/** Find a matching item. */ (c) => c.name === 'echo');
    assert.deepEqual(echo.surfaces, ['cli', 'mcp', 'programmatic']);
    assert.equal(echo.inputSchema, undefined); // no schema → no typed input
  } finally {
    await rt.stop();
  }
});

test('duplicate capability name throws at registration (unchanged)', /** Verify duplicate capability name throws at registration (unchanged). */ async () => {
  const rt = createRuntime();
  /** Implement dupes. */ function dupes(sumo) {
    sumo.command('dup', /** Run the callback. */ () => 1);
    assert.throws(/** Run the callback. */ () => sumo.command('dup', /** Run the callback. */ () => 2), /already registered/);
  }
  rt.sumo.use(dupes);
  await rt.start();
  await rt.stop();
});
