/**
 * LIVE Codex install-and-verify (spec 05/12): install Sumo's Codex hooks into a real project's
 * `.codex/hooks.json`, run a REAL `codex exec`, and confirm Codex invoked `sumo forward codex` through
 * the daemon-hosted plugin runtime. This test blocks at `UserPromptSubmit`, before any model/tool turn,
 * so it proves native hook forwarding without depending on tool-call budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open } from 'sumo/db';
import { Codex } from '../src/index.mjs';
import { installCodexHooks } from '../src/install/codex.mjs';
import { assertAvailable, liveUnavailableCodeFromText } from './_live.mjs';

const CLI = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url));

/**
 * Collect daemon events from a Sumo home.
 * @param {string} home
 * @returns {Promise<object[]>}
 */
async function readEvents(home) {
  const db = await open({ home });
  const events = [];
  try {
    for await (const [, event] of db.scan('evt:')) events.push(event);
  } finally {
    await db.close();
  }
  return events;
}

/**
 * Stop the autostarted Sumo daemon for a temp home.
 * @param {string} home
 * @returns {void}
 */
function killDaemon(home) {
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
    if (pid) process.kill(pid, 'SIGKILL');
  } catch { /* daemon already gone */ }
}

test('LIVE codex: installed UserPromptSubmit hook forwards through Sumo and blocks before model call', { timeout: 120_000 }, /** Verify LIVE codex: installed UserPromptSubmit hook forwards through Sumo and blocks before model call. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const codex = cfg.bin ?? 'codex';
  const help = spawnSync(codex, ['exec', '--help'], { encoding: 'utf8', timeout: 10_000 });
  if (!/--dangerously-bypass-hook-trust/.test(`${help.stdout}${help.stderr}`)) {
    t.skip('requires a Codex build with native hook trust bypass for automation');
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-codex-iv-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-codex-iv-proj-'));
  fs.writeFileSync(path.join(proj, 'sumo.yml'), "root: true\nuse:\n  - './plugin.mjs'\n");
  fs.writeFileSync(path.join(proj, 'plugin.mjs'),
    "export default function gate(sumo){ sumo.before('prompt',(e)=> e.payload.prompt?.includes('SUMO_CODEX_PROMPT_HOOK_LIVE') ? {deny:'CODEX-PROMPT-BLOCKED-BY-SUMO'} : undefined); }\n");

  const installed = installCodexHooks({
    projectDir: proj,
    hooks: [
      { event: 'SessionStart', matcher: 'startup|resume' },
      { event: 'UserPromptSubmit' }
    ],
    bin: `node ${CLI} forward codex`
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);

  try {
    const res = spawnSync(codex, [
      'exec',
      '--enable', 'hooks',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C', proj,
      'SUMO_CODEX_PROMPT_HOOK_LIVE: reply with this exact marker.'
    ], {
      cwd: proj,
      env: { ...process.env, SUMO_HOME: home },
      encoding: 'utf8',
      timeout: 120_000
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const unavailableCode = liveUnavailableCodeFromText(output);
    if (unavailableCode) {
      t.skip(`codex install live prerequisite unavailable: ${unavailableCode}`);
      return;
    }
    assert.match(output, /hook: UserPromptSubmit Blocked/, `expected Codex to honor the Sumo prompt deny; got:\n${output}`);

    const events = await readEvents(home);
    assert.ok(events.some(/** Test whether an item matches. */ (event) => event.source === 'hook' && event.adapter === 'codex' && event.type === 'session.started'), 'SessionStart was forwarded into the daemon event log');
    assert.ok(
      events.some(/** Test whether an item matches. */ (event) => event.source === 'hook' && event.adapter === 'codex' && event.type === 'session.message' && event.payload?.text?.includes('SUMO_CODEX_PROMPT_HOOK_LIVE')),
      'UserPromptSubmit was forwarded into the daemon event log'
    );
  } finally {
    killDaemon(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
