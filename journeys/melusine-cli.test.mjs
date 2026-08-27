import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MELUSINE = fileURLToPath(new URL('./melusine-cli.mjs', import.meta.url));

function runMelusine(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [MELUSINE, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 30_000
    }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error === 'object' && 'code' in error ? error.code : 0,
        stdout,
        stderr
      });
    });
  });
}

test('Melusine CLI executes the Sumo catalog without work-loop capability gaps', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-melusine-cli-'));
  try {
    const result = await runMelusine([
      'test',
      'journeys/claim-work-review-release.journey.md',
      '--catalog',
      'journeys/melusine.catalog.mjs'
    ], {
      SUMO_HOME: home,
      SUMO_IDLE_MS: '600000',
      SUMO_INGEST: '0'
    });

    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /gap todo \[detectWork\]/);
    assert.doesNotMatch(result.stderr, /work\.detect/);
    assert.doesNotMatch(result.stderr, /Capability backlog/);
  } finally {
    try {
      process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM');
    } catch {
      // daemon was never started or already exited
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
