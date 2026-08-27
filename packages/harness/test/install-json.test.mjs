import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJson, writeJsonIfChanged } from '../src/install/json.mjs';

/** Implement mkDir. */ function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-json-')); }

test('readJson: absent and blank files read as empty config', /** Verify readJson: absent and blank files read as empty config. */ () => {
  const dir = mkDir();
  const missing = path.join(dir, 'missing.json');
  assert.deepEqual(readJson(missing), { ok: true, value: {}, existed: false, text: '' });

  const blank = path.join(dir, 'blank.json');
  fs.writeFileSync(blank, '  \n');
  assert.deepEqual(readJson(blank), { ok: true, value: {}, existed: true, text: '  \n' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonIfChanged: absent or blank empty output is a no-op', /** Verify writeJsonIfChanged: absent or blank empty output is a no-op. */ () => {
  const dir = mkDir();
  const missing = path.join(dir, 'missing.json');
  assert.equal(writeJsonIfChanged(missing, readJson(missing), {}), false);
  assert.equal(fs.existsSync(missing), false);

  const blank = path.join(dir, 'blank.json');
  fs.writeFileSync(blank, '');
  assert.equal(writeJsonIfChanged(blank, readJson(blank), {}), false);
  assert.equal(fs.readFileSync(blank, 'utf8'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonIfChanged: writes when serialized output differs and no-ops when unchanged', /** Verify writeJsonIfChanged: writes when serialized output differs and no-ops when unchanged. */ () => {
  const dir = mkDir();
  const file = path.join(dir, 'config.json');
  const initial = readJson(file);
  assert.equal(writeJsonIfChanged(file, initial, { hooks: [] }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "hooks": []\n}\n');

  const unchanged = readJson(file);
  assert.equal(writeJsonIfChanged(file, unchanged, { hooks: [] }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson: malformed JSON returns a diagnostic Result', /** Verify readJson: malformed JSON returns a diagnostic Result. */ () => {
  const dir = mkDir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ nope');
  const result = readJson(file);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUMO_CONFIG_INVALID');
  assert.match(result.reason, /refusing to overwrite/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson reports real filesystem read failures', /** Verify readJson reports real filesystem read failures. */ () => {
  const dir = mkDir();
  const result = readJson(dir);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUMO_CONFIG_READ');
  assert.match(result.reason, /could not read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonIfChanged writes non-empty values over absent and blank files', /** Verify writeJsonIfChanged writes non-empty values over absent and blank files. */ () => {
  const dir = mkDir();
  const missing = path.join(dir, 'missing.json');
  assert.equal(writeJsonIfChanged(missing, readJson(missing), []), true);
  assert.equal(fs.readFileSync(missing, 'utf8'), '[]\n');

  const blank = path.join(dir, 'blank.json');
  fs.writeFileSync(blank, '\n');
  assert.equal(writeJsonIfChanged(blank, readJson(blank), { hooks: [] }), true);
  assert.equal(fs.readFileSync(blank, 'utf8'), '{\n  "hooks": []\n}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
