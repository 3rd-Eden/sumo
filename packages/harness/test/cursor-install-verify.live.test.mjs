/**
 * LIVE Cursor install-and-verify (spec 05 §"Verify by self-test", §3f/§5): install Sumo's
 * `beforeShellExecution` hook into a real project's `.cursor/hooks.json`, run a REAL `cursor-agent -p`
 * with a deny plugin, and confirm Cursor invoked `sumo forward cursor` and HONORED the deny — the full
 * decision loop through Cursor's real hook mechanism. No mocks; skip if `agent`/`cursor-agent` is absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertAvailable } from './_live.mjs';
import { Cursor } from '../src/index.mjs';
import { installCursorHooks } from '../src/install/cursor.mjs';

const CLI = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url));

test('LIVE cursor: an installed beforeShellExecution deny hook blocks the shell end to end', /** Verify LIVE cursor: an installed beforeShellExecution deny hook blocks the shell end to end. */ async (t) => {
  const cfg = await assertAvailable(Cursor, process.env.SUMO_CURSOR_BIN ? { bin: process.env.SUMO_CURSOR_BIN } : {}, t);
  if (!cfg) return;
  const cursor = cfg.bin ?? 'cursor-agent';

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cv-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cv-proj-'));
  fs.writeFileSync(path.join(proj, 'sumo.yml'), "root: true\nuse:\n  - './plugin.mjs'\n");
  fs.writeFileSync(path.join(proj, 'plugin.mjs'),
    "export default function gate(sumo){ sumo.before('tool',(e)=> /pwd/.test(e.payload.tool?.input?.command||'') ? {deny:'CURSOR-BLOCKED-BY-SUMO'} : undefined); }\n");

  const r = installCursorHooks({ projectDir: proj, events: ['beforeShellExecution'], bin: `node ${CLI} forward cursor` });
  assert.equal(r.changed, true);

  try {
    const res = spawnSync(cursor, ['-p', '--force', 'Use the shell to run the command: pwd'], {
      cwd: proj, env: { ...process.env, SUMO_HOME: home }, encoding: 'utf8', timeout: 120_000
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.match(output, /blocked by (?:a Cursor hook|a configured hook in Cursor Settings)|CURSOR-BLOCKED-BY-SUMO/, `expected Cursor to block the shell; got:\n${output}`);
  } finally {
    try {
      const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
      if (pid) process.kill(pid, 'SIGKILL');
    } catch { /* gone */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
