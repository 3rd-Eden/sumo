/**
 * Copilot hook install/reconcile (spec 05/12/13): idempotent, foreign-preserving, reversible, with
 * the documented repository-local `.github/hooks/*.json` shape. `permissionRequest` is installed
 * because its native hook payload and deny round-trip are captured from the real SDK path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_COPILOT_HOOKS,
  reconcileCopilotHooks,
  stripCopilotHooks,
  installCopilotHooks,
  uninstallCopilotHooks,
  copilotHooksPath,
  SUMO_COPILOT_SENTINEL
} from '../src/install/copilot.mjs';
import { resolveCopilotRuntime } from '../src/transport/CopilotServer.mjs';

/** Implement mkDir. */ function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copinst-')); }

test('reconcile is idempotent and writes version:1 + flat command entries', /** Verify reconcile is idempotent and writes version:1 + flat command entries. */ () => {
  const once = reconcileCopilotHooks({});
  const twice = reconcileCopilotHooks(once);
  assert.deepEqual(twice, once);
  assert.equal(once.version, 1);
  assert.ok(once.hooks.preToolUse[0].command.includes('sumo forward copilot preToolUse'));
  assert.ok(once.hooks.preToolUse[0].command.includes(SUMO_COPILOT_SENTINEL));
});

test('default install set includes captured permissionRequest hook', /** Verify default install set includes captured permissionRequest hook. */ () => {
  assert.equal(DEFAULT_COPILOT_HOOKS.some(/** Test whether an item matches. */ (hook) => hook.event === 'permissionRequest'), true);
  assert.equal(DEFAULT_COPILOT_HOOKS.some(/** Test whether an item matches. */ (hook) => hook.event === 'subagentStart'), true);
  const installed = reconcileCopilotHooks({});
  assert.ok(installed.hooks.permissionRequest[0].command.includes('sumo forward copilot permissionRequest'));
  assert.ok(installed.hooks.subagentStart[0].command.includes('sumo forward copilot subagentStart'));
});

test('reconcile preserves foreign Copilot hooks; uninstall restores them', /** Verify reconcile preserves foreign Copilot hooks; uninstall restores them. */ () => {
  const before = { version: 1, hooks: { preToolUse: [{ type: 'command', command: 'foreign-copilot-hook' }] } };
  const after = reconcileCopilotHooks(before);
  assert.ok(after.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'foreign-copilot-hook'));
  assert.ok(after.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command.includes(SUMO_COPILOT_SENTINEL)));
  const restored = stripCopilotHooks(after);
  assert.deepEqual(restored, before);
});

test('reconcile replaces stale Sumo commands and preserves malformed foreign buckets', /** Verify reconcile replaces stale Sumo commands and preserves malformed foreign buckets. */ () => {
  const before = {
    hooks: {
      preToolUse: [
        { type: 'command', command: `old ${SUMO_COPILOT_SENTINEL}` },
        { type: 'command', command: 'foreign-copilot-hook' }
      ],
      agentStop: [{ type: 'command', command: `stale ${SUMO_COPILOT_SENTINEL}` }],
      notification: 'not-an-array'
    }
  };
  const after = reconcileCopilotHooks(before, [{ event: 'preToolUse', matcher: 'Bash', safety: true, timeoutSec: 5 }], {
    bin: 'node /tmp/sumo/cli.mjs forward copilot'
  });

  assert.equal(after.version, 1);
  assert.ok(after.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'foreign-copilot-hook'));
  const sumo = after.hooks.preToolUse.find(/** Find a matching item. */ (entry) => entry.command.includes(SUMO_COPILOT_SENTINEL));
  assert.ok(sumo.command.startsWith('node /tmp/sumo/cli.mjs forward copilot preToolUse --safety'));
  assert.equal(sumo.matcher, 'Bash');
  assert.equal(sumo.timeoutSec, 5);
  assert.equal(after.hooks.agentStop, undefined);
  assert.equal(after.hooks.notification, 'not-an-array');
});

test('a foreign command mentioning forward copilot is preserved because ownership is sentinel-only', /** Verify a foreign command mentioning forward copilot is preserved because ownership is sentinel-only. */ () => {
  const before = { hooks: { preToolUse: [{ type: 'command', command: 'echo my sumo forward copilot helper' }] } };
  const after = reconcileCopilotHooks(before);
  assert.ok(after.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'echo my sumo forward copilot helper'));
  const restored = stripCopilotHooks(after);
  assert.ok(restored.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'echo my sumo forward copilot helper'));
});

test('strip handles absent and malformed Copilot hook config without touching foreign data', /** Verify strip handles absent and malformed Copilot hook config without touching foreign data. */ () => {
  assert.deepEqual(stripCopilotHooks({ theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(stripCopilotHooks({ hooks: 'not-an-object' }), { hooks: 'not-an-object' });
  assert.deepEqual(stripCopilotHooks({ hooks: { preToolUse: 'foreign-invalid' } }), { hooks: { preToolUse: 'foreign-invalid' } });
});

test('file round-trip: install writes .github/hooks/sumo.json, re-run no-op, uninstall reverts', /** Verify file round-trip: install writes .github/hooks/sumo.json, re-run no-op, uninstall reverts. */ () => {
  const dir = mkDir();
  const file = copilotHooksPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', command: 'foreign' }] } }, null, 2));

  const r1 = installCopilotHooks({ projectDir: dir });
  assert.equal(r1.changed, true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.version, 1);
  assert.ok(written.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command === 'foreign'));
  assert.ok(written.hooks.preToolUse.some(/** Test whether an item matches. */ (entry) => entry.command.includes('forward copilot preToolUse')));

  const r2 = installCopilotHooks({ projectDir: dir });
  assert.equal(r2.changed, false);
  const u = uninstallCopilotHooks({ projectDir: dir });
  assert.equal(u.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1,
    hooks: { preToolUse: [{ type: 'command', command: 'foreign' }] }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file round-trip reports malformed Copilot hooks without overwriting them', /** Verify file round-trip reports malformed Copilot hooks without overwriting them. */ () => {
  const dir = mkDir();
  fs.mkdirSync(path.dirname(copilotHooksPath(dir)), { recursive: true });
  fs.writeFileSync(copilotHooksPath(dir), '{ invalid json');

  const r = installCopilotHooks({ projectDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CONFIG_INVALID');
  assert.equal(fs.readFileSync(copilotHooksPath(dir), 'utf8'), '{ invalid json');

  const u = uninstallCopilotHooks({ projectDir: dir });
  assert.equal(u.ok, false);
  assert.equal(u.code, 'SUMO_CONFIG_INVALID');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('default Copilot runtime resolution prefers the packaged npm CLI over PATH shims', /** Verify default Copilot runtime resolution prefers the packaged npm CLI over PATH shims. */ () => {
  const resolved = resolveCopilotRuntime('copilot', {});
  assert.match(resolved, /@github[+/]copilot/);
  assert.doesNotMatch(resolved, /[\\/]shims[\\/]/);
});

test('explicit Copilot runtime config is honored', /** Verify explicit Copilot runtime config is honored. */ () => {
  assert.equal(resolveCopilotRuntime('/tmp/custom-copilot', {}), '/tmp/custom-copilot');
  assert.equal(resolveCopilotRuntime('copilot', { SUMO_COPILOT_BIN: '/tmp/env-copilot' }), '/tmp/env-copilot');
});
