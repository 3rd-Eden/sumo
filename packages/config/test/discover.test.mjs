import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChain, project, readConfigFile } from '../src/discover.mjs';

/** Build a throwaway directory tree; returns the root and registers cleanup. */
function tmpTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cfg-'));
  t.after(/** Run the after hook. */ () => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** An empty global home so tests never read the developer's real ~/.sumo/sumo.yml. */
function emptyHomeEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-home-'));
  t.after(/** Run the after hook. */ () => fs.rmSync(home, { recursive: true, force: true }));
  return { SUMO_HOME: home };
}

/** Implement files. */ function files(layers) { return layers.map(/** Map one item. */ (l) => path.basename(path.dirname(l.file))); }

test('loadChain and project discover config layers through real filesystem paths', /** Verify loadChain and project discover config layers through real filesystem paths. */ (t) => {
  const walkRoot = tmpTree(t, {
    'a/sumo.yml': 'use: [x]\n',
    'a/b/sumo.yml': 'use: [y]\n',
    'a/b/c/sumo.yml': 'use: [z]\n'
  });
  const walkEnv = emptyHomeEnv(t);
  const { layers } = loadChain({ cwd: path.join(walkRoot, 'a/b/c'), env: walkEnv, home: walkRoot });
  assert.deepEqual(files(layers), ['a', 'b', 'c']); // ordered top-most → nearest

  const gitRoot = tmpTree(t, {
    'sumo.yml': 'use: [above]\n', // above the repo root — must NOT be collected
    'repo/.git/HEAD': 'ref: x\n',
    'repo/sumo.yml': 'use: [repo]\n',
    'repo/pkg/sumo.yml': 'use: [pkg]\n'
  });
  const gitEnv = emptyHomeEnv(t);
  const gitChain = loadChain({ cwd: path.join(gitRoot, 'repo/pkg'), env: gitEnv, home: os.homedir() });
  assert.deepEqual(files(gitChain.layers), ['repo', 'pkg']);

  const homeRoot = tmpTree(t, {
    'sumo.yml': 'use: [above-home]\n', // above $HOME — excluded
    'home/sumo.yml': 'use: [home]\n',
    'home/proj/sumo.yml': 'use: [proj]\n'
  });
  const homeEnv = emptyHomeEnv(t);
  const home = path.join(homeRoot, 'home');
  const homeChain = loadChain({ cwd: path.join(home, 'proj'), env: homeEnv, home });
  assert.deepEqual(files(homeChain.layers), ['home', 'proj']);

  const explicitRoot = tmpTree(t, {
    'a/sumo.yml': 'use: [a]\n',
    'a/b/sumo.yml': 'root: true\nuse: [b]\n',
    'a/b/c/sumo.yml': 'use: [c]\n'
  });
  const explicitRootEnv = emptyHomeEnv(t);
  const rooted = loadChain({ cwd: path.join(explicitRoot, 'a/b/c'), env: explicitRootEnv, home: explicitRoot });
  assert.deepEqual(files(rooted.layers), ['b', 'c']); // a is above the root:true marker → excluded

  const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-home-'));
  t.after(/** Run the after hook. */ () => fs.rmSync(globalHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(globalHome, 'sumo.yml'), 'use: [global]\n');
  const globalRoot = tmpTree(t, { 'proj/sumo.yml': 'use: [proj]\n' });
  const globalChain = loadChain({ cwd: path.join(globalRoot, 'proj'), env: { SUMO_HOME: globalHome }, home: globalRoot });
  assert.equal(globalChain.layers[0].file, path.join(globalHome, 'sumo.yml'));
  assert.equal(globalChain.layers.length, 2);

  const badGlobalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-home-'));
  t.after(/** Run the after hook. */ () => fs.rmSync(badGlobalHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(badGlobalHome, 'sumo.yml'));
  const badGlobalRoot = tmpTree(t, { 'proj/sumo.yml': 'use: [proj]\n' });
  const badGlobal = loadChain({ cwd: path.join(badGlobalRoot, 'proj'), env: { SUMO_HOME: badGlobalHome }, home: badGlobalRoot });
  assert.equal(badGlobal.layers.length, 1);
  assert.ok(badGlobal.diagnostics.some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_CONFIG_READ' && d.source.file === path.join(badGlobalHome, 'sumo.yml')));

  const parseRoot = tmpTree(t, { 'proj/sumo.yml': 'use: [unterminated\n  : : :\n' });
  const parseEnv = emptyHomeEnv(t);
  const parsed = loadChain({ cwd: path.join(parseRoot, 'proj'), env: parseEnv, home: parseRoot });
  assert.equal(parsed.layers.length, 0);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].code, 'SUMO_CONFIG_PARSE');
  assert.equal(parsed.diagnostics[0].source.file, path.join(parseRoot, 'proj/sumo.yml'));

  const configRoot = tmpTree(t, {
    'a/sumo.yml': 'use: [a]\n',
    'a/b/custom.yml': 'use: [custom]\n'
  });
  const configEnv = emptyHomeEnv(t);
  const explicit = loadChain({
    cwd: path.join(configRoot, 'a/b'),
    flags: { config: path.join(configRoot, 'a/b/custom.yml') },
    env: configEnv,
    home: configRoot
  });
  // parent a/sumo.yml composes under the explicit file (explicit is nearest → last)
  assert.deepEqual(explicit.layers.map(/** Map one item. */ (l) => path.basename(l.file)), ['sumo.yml', 'custom.yml']);

  const isolatedRoot = tmpTree(t, {
    'a/sumo.yml': 'use: [a]\n',
    'a/b/custom.yml': 'root: true\nuse: [custom]\n'
  });
  const isolatedEnv = emptyHomeEnv(t);
  const isolated = loadChain({
    cwd: path.join(isolatedRoot, 'a/b'),
    flags: { config: path.join(isolatedRoot, 'a/b/custom.yml') },
    env: isolatedEnv,
    home: isolatedRoot
  });
  assert.deepEqual(isolated.layers.map(/** Map one item. */ (l) => path.basename(l.file)), ['custom.yml']); // no parent

  const missingRoot = tmpTree(t, {});
  const missingEnv = emptyHomeEnv(t);
  const missing = loadChain({
    cwd: missingRoot,
    flags: { config: path.join(missingRoot, 'nope.yml') },
    env: missingEnv,
    home: missingRoot
  });
  assert.ok(missing.diagnostics.some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_CONFIG_NOT_FOUND'));

  const readRoot = tmpTree(t, { 'sumo.yml': 'harness: { default: claude-code }\n' });
  assert.deepEqual(readConfigFile(path.join(readRoot, 'missing.yml')), {});
  assert.deepEqual(readConfigFile(path.join(readRoot, 'sumo.yml')).data, { harness: { default: 'claude-code' } });

  const emptyRoot = tmpTree(t, { 'sumo.yml': '\n' });
  assert.deepEqual(readConfigFile(path.join(emptyRoot, 'sumo.yml')), { data: {} });

  const scalarRoot = tmpTree(t, { 'proj/sumo.yml': '7\n' });
  const scalarEnv = emptyHomeEnv(t);
  const scalar = loadChain({ cwd: path.join(scalarRoot, 'proj'), env: scalarEnv, home: scalarRoot });
  assert.equal(scalar.layers.length, 0); // the bad layer never enters the chain
  assert.equal(scalar.diagnostics.length, 1);
  assert.equal(scalar.diagnostics[0].code, 'SUMO_CONFIG_INVALID');
  assert.equal(scalar.diagnostics[0].source.file, path.join(scalarRoot, 'proj/sumo.yml'));

  const arrayRoot = tmpTree(t, { 'proj/sumo.yml': '[not, mapping]\n' });
  const arrayEnv = emptyHomeEnv(t);
  const array = loadChain({ cwd: path.join(arrayRoot, 'proj'), env: arrayEnv, home: arrayRoot });
  assert.equal(array.diagnostics[0].code, 'SUMO_CONFIG_INVALID');
  assert.match(array.diagnostics[0].message, /array/);

  // A directory named sumo.yml makes readFileSync throw EISDIR — a read failure that must surface.
  const unreadableRoot = tmpTree(t, { 'proj/sumo.yml/.keep': '' });
  const unreadableEnv = emptyHomeEnv(t);
  const unreadable = loadChain({ cwd: path.join(unreadableRoot, 'proj'), env: unreadableEnv, home: unreadableRoot });
  assert.equal(unreadable.layers.length, 0);
  assert.ok(unreadable.diagnostics.some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_CONFIG_READ'));

  const relativeRoot = tmpTree(t, { 'proj/custom.yml': 'use: [c]\n' });
  const relativeEnv = emptyHomeEnv(t);
  const relative = loadChain({
    cwd: path.join(relativeRoot, 'proj'),
    flags: { config: 'custom.yml' }, // relative
    env: relativeEnv,
    home: relativeRoot
  });
  assert.equal(relative.diagnostics.length, 0);
  assert.equal(relative.layers.at(-1).file, path.join(relativeRoot, 'proj/custom.yml'));

  const projectRoot = tmpTree(t, {
    'repo/.git/HEAD': 'ref: main\n',
    'repo/pkg/sumo.yml': 'use: [pkg]\n'
  });
  const projectEnv = emptyHomeEnv(t);
  const pkg = path.join(projectRoot, 'repo/pkg');
  const nested = path.join(pkg, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(project({ cwd: nested, env: projectEnv, home: projectRoot }), pkg);

  const noConfig = path.join(projectRoot, 'repo/no-config');
  fs.mkdirSync(noConfig, { recursive: true });
  assert.equal(project({ cwd: noConfig, env: projectEnv, home: projectRoot }), path.join(projectRoot, 'repo'));

  const outside = path.join(projectRoot, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  assert.equal(project({ cwd: outside, env: projectEnv, home: projectRoot }), outside);
});
