import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registration, load, dependencies, sort } from '../src/use.mjs';

test('registration derives plugin identity from functions, declarations, wrappers and module specifiers', /** Verify registration derives plugin identity from functions, declarations, wrappers and module specifiers. */ () => {
  /** Implement myPlugin. */ function myPlugin() {}
  const fnReg = registration(myPlugin);
  assert.equal(fnReg.id, 'myPlugin');
  assert.equal(fnReg.kind, 'fn');
  assert.equal(fnReg.fn, myPlugin);

  /** Implement testGate. */ function testGate() {}
  testGate.sumo = {
    name: 'sumo-plugin-test-gate'
  };
  assert.equal(registration(testGate).id, 'sumo-plugin-test-gate');
  assert.equal(registration({
    name: 'aliased',
    fn: /** Implement whatever. */ function whatever() {}
  }).id, 'aliased');

  const moduleReg = registration('sumo-plugin-knowledge', {
    k: 1
  });
  assert.deepEqual({
    id: moduleReg.id,
    kind: moduleReg.kind,
    moduleSpec: moduleReg.moduleSpec,
    options: moduleReg.options
  }, {
    id: 'sumo-plugin-knowledge',
    kind: 'module',
    moduleSpec: 'sumo-plugin-knowledge',
    options: {
      k: 1
    }
  });

  /** Implement declaredPlugin. */ function declaredPlugin() {}
  declaredPlugin.sumo = {
    name: 'declared-object-plugin'
  };
  const unnamed = /** Implement namedOnlyForConstruction. */ function namedOnlyForConstruction() {};
  Object.defineProperty(unnamed, 'name', {
    value: ''
  });
  assert.equal(registration({
    fn: declaredPlugin
  }).id, 'declared-object-plugin');
  assert.equal(registration({
    fn: /** Implement namedObjectPlugin. */ function namedObjectPlugin() {}
  }).id, 'namedObjectPlugin');
  assert.throws(/** Run the callback. */ () => registration({
    fn: unnamed
  }), /no name given/);
  assert.throws(/** Run the callback. */ () => registration(''), /non-empty module specifier/);
  assert.throws(/** Run the callback. */ () => registration(/** Run the callback. */ () => {}), /anonymous/);
  assert.throws(/** Run the callback. */ () => registration(42), /expected a function/);
});

test('load resolves real module plugins from cwd and reports unusable modules', /** Verify load resolves real module plugins from cwd and reports unusable modules. */ async () => {
  const { fn, decl } = await load('./fixtures/echo-plugin.mjs', import.meta.dirname);
  assert.equal(typeof fn, 'function');
  assert.equal(decl.name, 'echo-plugin');

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-plugin-load-'));
  try {
    const pkg = path.join(cwd, 'node_modules', 'sumo-bare-plugin');
    fs.mkdirSync(pkg, {
      recursive: true
    });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'sumo-bare-plugin',
      type: 'module',
      exports: './index.mjs'
    }));
    fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export default function barePlugin() {};\nbarePlugin.sumo = { name: "bare-plugin" };\n');
    const loaded = await load('sumo-bare-plugin', cwd);
    assert.equal(loaded.fn.name, 'barePlugin');
    assert.equal(loaded.decl.name, 'bare-plugin');
  } finally {
    fs.rmSync(cwd, {
      recursive: true,
      force: true
    });
  }

  await assert.rejects(load('./fixtures/no-default-plugin.mjs', import.meta.dirname), /no default-exported plugin function/);
});

test('dependencies and sort preserve declared order, diamonds, cycles and missing-dep handoff', /** Verify dependencies and sort preserve declared order, diamonds, cycles and missing-dep handoff. */ () => {
  assert.deepEqual(dependencies({
    plugins: [
      'a',
      {
        name: 'b',
        version: '^2'
      }
    ]
  }), ['a', 'b']);
  assert.deepEqual(dependencies(undefined), []);

  const ordered = sort([
    {
      id: 'b',
      deps: ['a']
    },
    {
      id: 'a',
      deps: []
    }
  ]);
  assert.deepEqual(ordered.order, ['a', 'b']);
  assert.deepEqual(ordered.cycles, []);

  const diamond = sort([
    {
      id: 'a',
      deps: []
    },
    {
      id: 'b',
      deps: ['a']
    },
    {
      id: 'c',
      deps: ['a']
    },
    {
      id: 'd',
      deps: ['b', 'c']
    }
  ]).order;
  assert.ok(diamond.indexOf('a') < diamond.indexOf('b'));
  assert.ok(diamond.indexOf('a') < diamond.indexOf('c'));
  assert.ok(diamond.indexOf('b') < diamond.indexOf('d'));
  assert.ok(diamond.indexOf('c') < diamond.indexOf('d'));
  assert.equal(new Set(diamond).size, 4);

  const cycle = sort([
    {
      id: 'a',
      deps: ['b']
    },
    {
      id: 'b',
      deps: ['a']
    }
  ]);
  assert.equal(cycle.cycles.length >= 1, true);
  assert.deepEqual(cycle.order.sort(), ['a', 'b']);
  assert.deepEqual(sort([
    {
      id: 'a',
      deps: ['ghost']
    }
  ]).order, ['a']);
});
