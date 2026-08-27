/**
 * Step 6 (spec 05/12/13): Claude hook install/reconcile. Proves idempotency, foreign-config
 * preservation, Sumo-owned markers, and reversibility (uninstall restores the pre-install shape).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  reconcileClaudeSettings,
  stripSumoHooks,
  installClaudeHooks,
  uninstallClaudeHooks,
  claudeSettingsPath,
  SUMO_COMMAND_PREFIX,
  SUMO_HOOK_SENTINEL
} from '../src/install/claude.mjs';

/** Implement mkDir. */ function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-inst-')); }

test('reconcile is idempotent — applying twice yields identical settings', /** Verify reconcile is idempotent — applying twice yields identical settings. */ () => {
  const once = reconcileClaudeSettings({});
  const twice = reconcileClaudeSettings(once);
  assert.deepEqual(twice, once);
  // and it actually installed our commands
  assert.ok(once.hooks.PreToolUse[0].hooks[0].command.startsWith(SUMO_COMMAND_PREFIX));
});

test('reconcile preserves foreign hooks and other settings blocks', /** Verify reconcile preserves foreign hooks and other settings blocks. */ () => {
  const before = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'foreign-precompact' }] }]
    }
  };
  const after = reconcileClaudeSettings(before);

  // foreign settings + foreign hooks survive
  assert.equal(after.model, 'opus');
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'my-own-linter'), 'foreign PreToolUse kept');
  assert.ok(after.hooks.PreCompact.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'foreign-precompact'), 'foreign event kept');
  // and Sumo's PreToolUse entry was added alongside
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command.startsWith(SUMO_COMMAND_PREFIX)));
});

test('reversible: uninstall restores the exact pre-install shape (foreign-only)', /** Verify reversible: uninstall restores the exact pre-install shape (foreign-only). */ () => {
  const before = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }] }
  };
  const installed = reconcileClaudeSettings(before);
  const restored = stripSumoHooks(installed);
  assert.deepEqual(restored, before);
});

test('uninstall on a Sumo-only file removes the hooks block entirely', /** Verify uninstall on a Sumo-only file removes the hooks block entirely. */ () => {
  const installed = reconcileClaudeSettings({});
  const restored = stripSumoHooks(installed);
  assert.deepEqual(restored, {}); // nothing foreign → empty
});

test('safety flag appends --safety; every command carries the Sumo sentinel marker', /** Verify safety flag appends --safety; every command carries the Sumo sentinel marker. */ () => {
  const after = reconcileClaudeSettings({}, [{ event: 'PreToolUse', matcher: 'Bash', safety: true }]);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, `${SUMO_COMMAND_PREFIX} PreToolUse --safety ${SUMO_HOOK_SENTINEL}`);
  assert.equal(after.hooks.PreToolUse[0].matcher, 'Bash');
});

test('a FOREIGN command containing the literal "forward claude-code" is NOT clobbered (sentinel only)', /** Verify a FOREIGN command containing the literal "forward claude-code" is NOT clobbered (sentinel only). */ () => {
  // The old substring marker would have removed this; the sentinel marker must not.
  const before = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo my sumo forward claude-code helper' }] }] } };
  const after = reconcileClaudeSettings(before);
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'echo my sumo forward claude-code helper'), 'foreign command preserved');
  const restored = stripSumoHooks(after);
  assert.ok(restored.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'echo my sumo forward claude-code helper'), 'uninstall keeps the foreign command');
});

test('reconcile replaces stale Sumo entries and tolerates malformed hook buckets', /** Verify reconcile replaces stale Sumo entries and tolerates malformed hook buckets. */ () => {
  const before = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: `old PreToolUse ${SUMO_HOOK_SENTINEL}` }] },
        { hooks: [{ type: 'command', command: 'foreign-pretool' }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: `old Stop ${SUMO_HOOK_SENTINEL}` }] }],
      PostToolUse: 'not-an-array'
    }
  };

  const after = reconcileClaudeSettings(
    before,
    [
      { event: 'PreToolUse', matcher: 'Bash', safety: true },
      { event: 'PreToolUse', matcher: 'Write' }
    ],
    { bin: 'node /tmp/sumo/cli.mjs forward claude-code' }
  );

  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'foreign-pretool'));
  assert.equal(after.hooks.PreToolUse.filter(/** Select matching items. */ (e) => e.hooks[0].command.includes(SUMO_HOOK_SENTINEL)).length, 2);
  assert.equal(after.hooks.Stop, undefined, 'stale Sumo-only event bucket was removed');
  assert.equal(after.hooks.PostToolUse, 'not-an-array', 'foreign malformed bucket is preserved for the user to fix');
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command.startsWith('node /tmp/sumo/cli.mjs forward claude-code PreToolUse --safety')));
});

test('strip leaves non-hook and malformed hook shapes untouched', /** Verify strip leaves non-hook and malformed hook shapes untouched. */ () => {
  assert.deepEqual(stripSumoHooks({ model: 'opus' }), { model: 'opus' });
  assert.deepEqual(stripSumoHooks({ hooks: 'not-an-object' }), { hooks: 'not-an-object' });
  assert.deepEqual(stripSumoHooks({ hooks: { PreToolUse: 'foreign-invalid' } }), { hooks: { PreToolUse: 'foreign-invalid' } });
});

test('file round-trip: install writes, re-run is a no-op, uninstall reverts', /** Verify file round-trip: install writes, re-run is a no-op, uninstall reverts. */ () => {
  const dir = mkDir();
  // a pre-existing foreign settings file
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(claudeSettingsPath(dir), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'foreign' }] }] } }, null, 2));

  const r1 = installClaudeHooks({ projectDir: dir });
  assert.equal(r1.changed, true);
  const r2 = installClaudeHooks({ projectDir: dir });
  assert.equal(r2.changed, false, 're-running install is a no-op');

  const written = JSON.parse(fs.readFileSync(claudeSettingsPath(dir), 'utf8'));
  assert.equal(written.model, 'opus');
  assert.ok(written.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'foreign'), 'foreign preserved');

  const u = uninstallClaudeHooks({ projectDir: dir });
  assert.equal(u.changed, true);
  const final = JSON.parse(fs.readFileSync(claudeSettingsPath(dir), 'utf8'));
  assert.deepEqual(final, { model: 'opus', hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'foreign' }] }] } });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('file round-trip reports malformed Claude settings without overwriting them', /** Verify file round-trip reports malformed Claude settings without overwriting them. */ () => {
  const dir = mkDir();
  fs.mkdirSync(path.dirname(claudeSettingsPath(dir)), { recursive: true });
  fs.writeFileSync(claudeSettingsPath(dir), '{ invalid json');

  const r = installClaudeHooks({ projectDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CONFIG_INVALID');
  assert.equal(fs.readFileSync(claudeSettingsPath(dir), 'utf8'), '{ invalid json');

  const u = uninstallClaudeHooks({ projectDir: dir });
  assert.equal(u.ok, false);
  assert.equal(u.code, 'SUMO_CONFIG_INVALID');
  fs.rmSync(dir, { recursive: true, force: true });
});
