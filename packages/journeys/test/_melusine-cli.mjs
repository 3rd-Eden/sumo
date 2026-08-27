import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MELUSINE = fileURLToPath(new URL('../../../journeys/melusine-cli.mjs', import.meta.url));

export function runJourneyCli(journey, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [
      MELUSINE,
      'test',
      journey,
      '--catalog',
      'journeys/melusine.catalog.mjs'
    ], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 480_000,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error === 'object' && 'code' in error ? error.code : 0,
        stdout,
        stderr
      });
    });
  });
}

export function stopDaemon(home) {
  try {
    process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM');
  } catch {
    // daemon was never started or already exited
  }
}
