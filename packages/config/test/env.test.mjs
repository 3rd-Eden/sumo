import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { sumoHome, globalConfigPath, explicitConfigPath, applyEnv } from '../src/env.mjs';

test('sumoHome honors SUMO_HOME, else ~/.sumo', /** Verify sumoHome honors SUMO_HOME, else ~/.sumo. */ () => {
  assert.equal(sumoHome({ SUMO_HOME: '/custom/home' }), '/custom/home');
  assert.equal(sumoHome({}), path.join(os.homedir(), '.sumo'));
});

test('globalConfigPath is <home>/sumo.yml', /** Verify globalConfigPath is <home>/sumo.yml. */ () => {
  assert.equal(globalConfigPath({ SUMO_HOME: '/h' }), path.join('/h', 'sumo.yml'));
});

test('explicitConfigPath: flags.config beats SUMO_CONFIG', /** Verify explicitConfigPath: flags.config beats SUMO_CONFIG. */ () => {
  assert.equal(explicitConfigPath({ config: '/a.yml' }, { SUMO_CONFIG: '/b.yml' }), '/a.yml');
  assert.equal(explicitConfigPath({}, { SUMO_CONFIG: '/b.yml' }), '/b.yml');
  assert.equal(explicitConfigPath({}, {}), undefined);
});

test('applyEnv: SUMO_DB overrides storage.path, preserving siblings', /** Verify applyEnv: SUMO_DB overrides storage.path, preserving siblings. */ () => {
  const out = applyEnv({ storage: { retention: { rawDays: 14 } } }, { SUMO_DB: '/var/db' });
  assert.deepEqual(out.storage, { retention: { rawDays: 14 }, path: '/var/db' });
});

test('applyEnv: no SUMO_DB returns config unchanged', /** Verify applyEnv: no SUMO_DB returns config unchanged. */ () => {
  const cfg = { storage: { path: 'a' } };
  assert.equal(applyEnv(cfg, {}), cfg);
});
