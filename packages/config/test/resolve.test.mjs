import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolve } from '../src/resolve.mjs';

/**
 * Build a throwaway project tree + an empty global home. A `.git` marker at the tree root makes the
 * upward walk stop there (git-root stop rule) so tests are hermetic without reaching the real $HOME —
 * which is why `resolve` needs no test-only boundary override. Returns { root, home, env }.
 */
function scaffold(t, files, globalYml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cfg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-home-'));
  t.after(/** Run the after hook. */ () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // git-root stop boundary
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (globalYml != null) fs.writeFileSync(path.join(home, 'sumo.yml'), globalYml);
  return { root, home, env: { SUMO_HOME: home } };
}

test('resolve composes config layers, plugin diagnostics, env overrides and invalid inputs', /** Verify resolve composes config layers, plugin diagnostics, env overrides and invalid inputs. */ (t) => {
  const layered = scaffold(
    t,
    {
      'a/sumo.yml': 'harness: { default: parent }\nuse: [p]\n',
      'a/b/sumo.yml': 'harness: { default: nearest }\nuse: [n]\n'
    },
    'harness: { default: global }\nuse: [g]\n'
  );
  const { config, diagnostics } = resolve({
    cwd: path.join(layered.root, 'a/b'),
    flags: { harness: { default: 'flag' } },
    env: layered.env
  });
  assert.equal(diagnostics.length, 0);
  assert.equal(config.harness.default, 'flag'); // flags win over all file layers + env
  assert.deepEqual(config.use, ['g', 'p', 'n']); // arrays concat in precedence order
  assert.equal(config.daemon.scope, 'project'); // core default applied
  assert.ok(layered.home); // home fixture exists

  const rooted = scaffold(
    t,
    {
      'a/sumo.yml': 'use: [a]\n', // above the root marker → excluded
      'a/b/sumo.yml': 'root: true\nuse: [b]\n'
    },
    'use: [g]\n'
  );
  const rootedResult = resolve({ cwd: path.join(rooted.root, 'a/b'), env: rooted.env });
  assert.ok(!rootedResult.config.use.includes('a')); // parent above root:true excluded
  assert.ok(rootedResult.config.use.includes('b'));
  assert.ok(rootedResult.config.use.includes('g')); // global is unconditional

  const removed = scaffold(t, {
    'a/sumo.yml': 'use: [keep, noisy]\n',
    'a/b/sumo.yml': 'use: ["~noisy"]\n'
  });
  const removedResult = resolve({ cwd: path.join(removed.root, 'a/b'), env: removed.env });
  assert.deepEqual(removedResult.config.use, ['keep']);

  const invalidPlugin = scaffold(t, {
    'proj/sumo.yml': 'use: [github]\nplugins:\n  github:\n    label: 1\n' // missing repo, bad label
  });
  const githubSchema = z.object({ repo: z.string(), label: z.string().default('sumo:ready') });
  const pluginResult = resolve({
    cwd: path.join(invalidPlugin.root, 'proj'),
    env: invalidPlugin.env,
    pluginSchemas: { github: githubSchema }
  });
  assert.equal(pluginResult.plugins.github.available, false);
  const d = pluginResult.diagnostics.find(/** Find a matching item. */ (x) => x.code === 'SUMO_PLUGIN_CONFIG_INVALID');
  assert.ok(d, 'expected a plugin-config diagnostic');
  assert.equal(d.source.plugin, 'github');
  assert.equal(d.source.file, path.join(invalidPlugin.root, 'proj/sumo.yml'));

  const explicit = scaffold(
    t,
    {
      'a/sumo.yml': 'use: [a]\n',
      'a/b/custom.yml': 'use: [c]\n'
    },
    'use: [g]\n'
  );
  const explicitResult = resolve({
    cwd: path.join(explicit.root, 'a/b'),
    flags: { config: path.join(explicit.root, 'a/b/custom.yml') },
    env: explicit.env
  });
  assert.deepEqual(explicitResult.config.use, ['g', 'a', 'c']); // global + parent + explicit-as-nearest

  const isolated = scaffold(
    t,
    {
      'a/sumo.yml': 'use: [a]\n',
      'a/b/custom.yml': 'root: true\nuse: [c]\n'
    },
    'use: [g]\n'
  );
  const isolatedResult = resolve({
    cwd: path.join(isolated.root, 'a/b'),
    flags: { config: path.join(isolated.root, 'a/b/custom.yml') },
    env: isolated.env
  });
  assert.deepEqual(isolatedResult.config.use, ['g', 'c']); // parent 'a' excluded; global 'g' kept

  const storage = scaffold(t, { 'proj/sumo.yml': 'storage: { path: from-file }\n' });
  const envWithDb = { ...storage.env, SUMO_DB: '/from-env' };

  // env beats the file layer
  const a = resolve({ cwd: path.join(storage.root, 'proj'), env: envWithDb });
  assert.equal(a.config.storage.path, '/from-env');

  // flags beat env
  const b = resolve({
    cwd: path.join(storage.root, 'proj'),
    env: envWithDb,
    flags: { storage: { path: '/from-flag' } }
  });
  assert.equal(b.config.storage.path, '/from-flag');

  const badCore = scaffold(t, { 'proj/sumo.yml': 'daemon: { scope: planet }\n' });
  const badCoreResult = resolve({ cwd: path.join(badCore.root, 'proj'), env: badCore.env });
  const badCoreDiagnostic = badCoreResult.diagnostics.find(/** Find a matching item. */ (x) => x.code === 'SUMO_CONFIG_INVALID');
  assert.ok(badCoreDiagnostic);
  assert.equal(badCoreDiagnostic.source.file, path.join(badCore.root, 'proj/sumo.yml'));

  const badUse = scaffold(t, { 'proj/sumo.yml': 'use: 7\n' }); // use must be a string[]
  let badUseResult;
  assert.doesNotThrow(/** Run the callback. */ () => {
    badUseResult = resolve({ cwd: path.join(badUse.root, 'proj'), env: badUse.env, pluginSchemas: {} });
  });
  assert.ok(badUseResult.diagnostics.some(/** Test whether an item matches. */ (diag) => diag.code === 'SUMO_CONFIG_INVALID'));
  assert.deepEqual(badUseResult.plugins, {}); // no plugins validated, no crash

  const badPlugins = scaffold(t, { 'proj/sumo.yml': 'use: [github]\nplugins: []\n' });
  const badPluginsResult = resolve({ cwd: path.join(badPlugins.root, 'proj'), env: badPlugins.env, pluginSchemas: { github: z.object({ repo: z.string() }) } });
  assert.ok(badPluginsResult.diagnostics.some(/** Test whether an item matches. */ (diag) => diag.code === 'SUMO_CONFIG_INVALID'));
  assert.deepEqual(badPluginsResult.plugins.github.available, false);
  assert.match(badPluginsResult.plugins.github.reason, /repo/);

  const flagOnly = scaffold(t, {});
  const flagResult = resolve({
    cwd: flagOnly.root,
    env: flagOnly.env,
    flags: { daemon: { scope: 'planet' } }
  });
  const flagDiagnostic = flagResult.diagnostics.find(/** Find a matching item. */ (x) => x.code === 'SUMO_CONFIG_INVALID');
  assert.ok(flagDiagnostic);
  assert.deepEqual(flagDiagnostic.source, {});

  const nonMapping = scaffold(t, { 'proj/sumo.yml': '"just a string"\n' }, 'use: [g]\n');
  const nonMappingResult = resolve({ cwd: path.join(nonMapping.root, 'proj'), env: nonMapping.env });
  assert.deepEqual(nonMappingResult.config.use, ['g']); // global survives; the bad layer was skipped
  assert.ok(nonMappingResult.diagnostics.some(/** Test whether an item matches. */ (diag) => diag.code === 'SUMO_CONFIG_INVALID'));
});
