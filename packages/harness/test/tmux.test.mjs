import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tmuxAvailable } from '../src/transport/tmux.mjs';

const realPath = process.env.PATH;
afterEach(/** Run the afterEach hook. */ () => { process.env.PATH = realPath; });

/** Implement binDir. */ function binDir(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tmux-'));
  const p = path.join(dir, 'tmux');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return dir;
}

test('tmuxAvailable uses the shared binary probe and reports a working tmux', /** Verify tmuxAvailable uses the shared binary probe and reports a working tmux. */ async () => {
  process.env.PATH = binDir('#!/bin/sh\nprintf "tmux 3.4\\n"\n');
  assert.equal(await tmuxAvailable(), true);
});

test('tmuxAvailable reports false when tmux is absent or broken', /** Verify tmuxAvailable reports false when tmux is absent or broken. */ async () => {
  process.env.PATH = binDir('#!/bin/sh\nexit 1\n');
  assert.equal(await tmuxAvailable(), false);
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-no-tmux-'));
  assert.equal(await tmuxAvailable(), false);
});
