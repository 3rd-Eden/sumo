/**
 * Step 6 LIVE install-and-verify (spec 05 §"Verify by self-test", §3f/§5): install Sumo's PreToolUse
 * hook into a real project's `.claude/settings.json`, run a REAL `claude` with a deny plugin, and
 * confirm Claude invoked `sumo forward` and honored the deny. No mocks; skip if `claude` is absent.
 *
 * This is the only test that proves the FULL loop end to end through the real Claude hook mechanism:
 * install → claude triggers PreToolUse → `sumo forward claude-code` → auto-spawned steering daemon →
 * project runtime `before('tool')` → native deny → Claude blocks the tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireBin } from './_live.mjs';
import { installClaudeHooks } from '../src/install/claude.mjs';

const CLI = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url));

test('LIVE claude: an installed PreToolUse deny hook blocks the Bash tool end to end', /** Verify LIVE claude: an installed PreToolUse deny hook blocks the Bash tool end to end. */ (t) => {
  const claude = requireBin('claude', 'SUMO_CLAUDE_BIN', t);
  if (!claude) return;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-iv-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-iv-proj-'));
  fs.writeFileSync(path.join(proj, 'sumo.yml'), "root: true\nuse:\n  - './plugin.mjs'\n");
  fs.writeFileSync(path.join(proj, 'plugin.mjs'),
    "export default function gate(sumo){ sumo.before('tool',(e)=> e.payload.tool?.name==='Bash' ? {deny:'BLOCKED-BY-SUMO-LIVE'} : undefined); }\n");

  // Install the hook, pointing the command at THIS repo's CLI (so `sumo` need not be on PATH).
  const r = installClaudeHooks({ projectDir: proj, hooks: [{ event: 'PreToolUse', matcher: 'Bash' }], bin: `node ${CLI} forward claude-code` });
  assert.equal(r.changed, true);

  try {
    // Force genuine tool use: a command whose output Claude cannot infer without actually running it,
    // so it MUST invoke the Bash tool → the PreToolUse hook fires → Sumo denies. (A plain `pwd` lets
    // Claude shortcut from context without a tool call, which would never exercise the hook.)
    const res = spawnSync(claude, ['-p', 'Run the shell command `echo sumo-live-probe-$RANDOM` using the Bash tool and report its exact output. You must invoke the Bash tool — do not answer from memory.', '--permission-mode', 'bypassPermissions'], {
      cwd: proj,
      env: { ...process.env, SUMO_HOME: home },
      encoding: 'utf8',
      timeout: 120_000
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.match(output, /BLOCKED-BY-SUMO-LIVE/, `expected Claude to surface the Sumo deny reason; got:\n${output}`);
  } finally {
    try {
      const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
      if (pid) process.kill(pid, 'SIGKILL');
    } catch { /* daemon already gone */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
