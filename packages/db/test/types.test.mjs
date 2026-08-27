import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Real type-check: run the actual TypeScript compiler over the source. tsc exits non-zero on any
// type error, so a passing run asserts the JSDoc annotations are correct; we also assert that the
// declaration (.d.mts) artifacts are produced. No mocks — this is the same compiler `pnpm types` runs.

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..'); // packages/db/test -> repo root

test('JSDoc type-checks under tsc and emits declaration files', /** Verify JSDoc type-checks under tsc and emits declaration files. */ async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-types-'));
  try {
    // rejects (test fails) if tsc reports any type error
    await run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json'), '--outDir', out], { cwd: root });

    const decl = path.join(out, 'packages/db/src/index.d.mts');
    assert.ok(fs.existsSync(decl), 'expected index.d.mts to be emitted');
    assert.match(fs.readFileSync(decl, 'utf8'), /export \{ open \}/);

    // the SumoDb shape carries through to the declaration of the client
    const clientDecl = fs.readFileSync(path.join(out, 'packages/db/src/client.d.mts'), 'utf8');
    assert.match(clientDecl, /export type SumoDb/);
    assert.match(clientDecl, /append:/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
