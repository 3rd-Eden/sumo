/**
 * Cursor renamed its CLI from `cursor-agent` to `agent`. `resolveCursorBin()` must prefer `agent` when
 * present, fall back to the legacy `cursor-agent`, and never silently resolve to something else.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Cursor, resolveCursorBin } from '../src/adapters/cursor.mjs';

const realPath = process.env.PATH;
afterEach(/** Run the afterEach hook. */ () => { process.env.PATH = realPath; });

/** Make a temp dir holding executable binary fixtures with the given names, and return the dir. */
function binDir(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-bin-'));
  for (const name of names) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  }
  return dir;
}

test('prefers `agent` over `cursor-agent` when both are on PATH', /** Verify prefers `agent` over `cursor-agent` when both are on PATH. */ () => {
  const a = binDir('agent');
  const b = binDir('cursor-agent');
  process.env.PATH = [b, a].join(path.delimiter); // cursor-agent dir listed FIRST — preference is by name, not order
  assert.equal(resolveCursorBin(), 'agent');
});

test('falls back to `cursor-agent` when only the legacy binary exists', /** Verify falls back to `cursor-agent` when only the legacy binary exists. */ () => {
  process.env.PATH = binDir('cursor-agent');
  assert.equal(resolveCursorBin(), 'cursor-agent');
});

test('resolves `agent` when only the new binary exists', /** Verify resolves `agent` when only the new binary exists. */ () => {
  process.env.PATH = binDir('agent');
  assert.equal(resolveCursorBin(), 'agent');
});

test('returns the legacy name when neither is installed (clear spawn error downstream)', /** Verify returns the legacy name when neither is installed (clear spawn error downstream). */ () => {
  process.env.PATH = binDir('something-else');
  assert.equal(resolveCursorBin(), 'cursor-agent');
});

test('ignores the desktop `cursor` launcher on PATH', /** Verify ignores the desktop `cursor` launcher on PATH. */ () => {
  process.env.PATH = binDir('cursor');
  assert.equal(resolveCursorBin(), 'cursor-agent');
});

test('explicit desktop `cursor` binary is unavailable without execution', /** Verify explicit desktop `cursor` binary is unavailable without execution. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cursor-desktop-'));
  const marker = path.join(dir, 'executed');
  const bin = path.join(dir, 'cursor');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });

  const result = await new Cursor({ config: { bin } }).available();
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /desktop launcher/);
  assert.equal(fs.existsSync(marker), false, 'availability guard must not spawn desktop cursor');
});
