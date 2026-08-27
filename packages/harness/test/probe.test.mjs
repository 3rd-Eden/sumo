import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify } from '../src/base/classify.mjs';
import { probeBinary, spawnCollect, whichSync } from '../src/base/probe.mjs';
import { liveUnavailableCodeFromText } from './_live.mjs';

const realPath = process.env.PATH;
afterEach(/** Run the afterEach hook. */ () => {
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
});

/** Implement executable. */ function executable(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-probe-bin-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return { dir, file };
}

test('whichSync resolves executable PATH entries and reports an empty PATH honestly', /** Verify whichSync resolves executable PATH entries and reports an empty PATH honestly. */ () => {
  const { dir, file } = executable('sumo-probe-ok', '#!/bin/sh\nexit 0\n');
  try {
    process.env.PATH = dir;
    assert.equal(whichSync('sumo-probe-ok'), file);
    delete process.env.PATH;
    assert.equal(whichSync('sumo-probe-ok'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnCollect captures real stdout/stderr, process errors and timeout kills', /** Verify spawnCollect captures real stdout/stderr, process errors and timeout kills. */ async () => {
  const ok = executable('sumo-probe-collect', '#!/bin/sh\nprintf "out\\n"\nprintf "err\\n" >&2\n');
  const slow = executable('sumo-probe-slow', '#!/bin/sh\nsleep 2\n');
  try {
    const collected = await spawnCollect(ok.file, []);
    assert.equal(collected.code, 0);
    assert.match(collected.out, /out/);
    assert.match(collected.out, /err/);

    const missing = await spawnCollect(path.join(ok.dir, 'missing-bin'), []);
    assert.equal(missing.code, 1);

    const invalid = await spawnCollect('\0', []);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.out, '');

    const timedOut = await spawnCollect(slow.file, [], 20);
    assert.equal(timedOut.code, null);
  } finally {
    fs.rmSync(ok.dir, { recursive: true, force: true });
    fs.rmSync(slow.dir, { recursive: true, force: true });
  }
});

test('probeBinary verifies absolute and PATH binaries through real --version execution', /** Verify probeBinary verifies absolute and PATH binaries through real --version execution. */ async () => {
  const good = executable('sumo-probe-version', '#!/bin/sh\nprintf "probe 1.2.3\\nextra\\n"\n');
  const stderrVersion = executable('sumo-probe-stderr-version', '#!/bin/sh\nprintf "probe-stderr 2.0.0\\n" >&2\n');
  const quiet = executable('sumo-probe-quiet-version', '#!/bin/sh\nexit 0\n');
  const bad = executable('sumo-probe-bad', '#!/bin/sh\nprintf "broken\\n" >&2\nexit 7\n');
  try {
    process.env.PATH = good.dir;
    assert.deepEqual(await probeBinary('sumo-probe-version'), { available: true, version: 'probe 1.2.3' });

    const absolute = await probeBinary(good.file);
    assert.deepEqual(absolute, { available: true, version: 'probe 1.2.3' });

    assert.deepEqual(await probeBinary(stderrVersion.file), { available: true, version: 'probe-stderr 2.0.0' });
    assert.deepEqual(await probeBinary(quiet.file), { available: true, version: null });

    const missing = await probeBinary('sumo-probe-missing');
    assert.equal(missing.available, false);
    assert.equal(missing.version, null);
    assert.match(missing.reason, /not found/);

    const failed = await probeBinary(bad.file);
    assert.equal(failed.available, false);
    assert.equal(failed.version, null);
    assert.match(failed.reason, /Command failed/);
  } finally {
    fs.rmSync(good.dir, { recursive: true, force: true });
    fs.rmSync(stderrVersion.dir, { recursive: true, force: true });
    fs.rmSync(quiet.dir, { recursive: true, force: true });
    fs.rmSync(bad.dir, { recursive: true, force: true });
  }
});

test('classifier maps external API key auth provider failures to auth-required', /** Verify classifier maps external API key auth provider failures to auth-required. */ () => {
  const result = classify({
    stderr: 'Failed to resolve external API key auth: provider auth command `/home/example/.local/bin/auth-helper` timed out after 5000 ms'
  });
  assert.equal(result.code, 'SUMO_AUTH_REQUIRED');
  assert.equal(result.fallback, true);
});

test('classifier covers subprocess recovery taxonomy', /** Verify classifier covers subprocess recovery taxonomy. */ () => {
  const unavailable = Object.assign(new Error('missing binary'), { code: 'ENOENT' });
  const osFailure = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
  const cases = [
    [{ spawnError: unavailable }, 'SUMO_BACKEND_UNAVAILABLE', false, true],
    [{ spawnError: osFailure }, 'SUMO_SPAWN_FAILED', true, false],
    [{}, 'SUMO_SPAWN_FAILED', true, false],
    [{ stderr: 'This request violates our usage policies.' }, 'SUMO_SPAWN_FAILED', false, true],
    [{ stderr: 'Usage limit reached, try again in 5 minutes.' }, 'SUMO_RATE_LIMITED', true, true],
    [{ stderr: 'Quota limit exceeded.' }, 'SUMO_BUDGET_EXHAUSTED', false, true],
    [{ stderr: 'Credits exhausted for this account.' }, 'SUMO_BUDGET_EXHAUSTED', false, true],
    [{ stderr: 'Too many requests, please retry after 10 seconds.' }, 'SUMO_RATE_LIMITED', true, true],
    [{ stderr: 'The requested model does not exist.' }, 'SUMO_MODEL_NOT_FOUND', false, false],
    [{ stderr: 'Server overloaded, try again later.' }, 'SUMO_OVERLOADED', true, true],
    [{ stderr: 'child process exited unexpectedly', snapshot: 'different captured pane text' }, 'SUMO_SPAWN_FAILED', true, false]
  ];
  for (const [evidence, code, retryable, fallback] of cases) {
    const result = classify(evidence);
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(result.fallback, fallback);
  }
});

test('classifier also uses snapshot-only evidence and ignores duplicate snapshot text', /** Verify classifier also uses snapshot-only evidence and ignores duplicate snapshot text. */ () => {
  const snapshotOnly = classify({ snapshot: 'Please log in before continuing.' });
  assert.equal(snapshotOnly.code, 'SUMO_AUTH_REQUIRED');

  const duplicateSnapshot = classify({
    stderr: 'Too many requests, please retry after 10 seconds.',
    snapshot: 'too many requests, please retry after 10 seconds.'
  });
  assert.equal(duplicateSnapshot.code, 'SUMO_RATE_LIMITED');
});

test('live unavailable helper preserves already-rendered SUMO codes', /** Verify live unavailable helper preserves already-rendered SUMO codes. */ () => {
  assert.equal(
    liveUnavailableCodeFromText('sumo/journey-catalog(catalog): session ses_X live prerequisite unavailable: SUMO_AUTH_REQUIRED'),
    'SUMO_AUTH_REQUIRED'
  );
});
