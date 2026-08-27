/**
 * Codex hook install/reconcile (spec 05/12/13): idempotent, foreign-preserving, reversible, with the
 * `.codex/hooks.json` shape verified from the captured Codex adapter adapter + the real
 * `~/.codex/superpowers/hooks/hooks.json` format.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { reconcileCodexHooks, stripCodexHooks, installCodexHooks, uninstallCodexHooks, codexHooksPath, codexConfigTomlPath, codexHooksEnabled, SUMO_CODEX_SENTINEL, DEFAULT_CODEX_HOOKS } from '../src/install/codex.mjs';
import { resolveCodexBin } from '../src/adapters/codex.mjs';

/** Implement mkDir. */ function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cxinst-')); }

test('reconcile is idempotent and produces Claude-shaped nested hook entries', /** Verify reconcile is idempotent and produces Claude-shaped nested hook entries. */ () => {
  const once = reconcileCodexHooks({});
  const twice = reconcileCodexHooks(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(Object.keys(once.hooks).sort(), DEFAULT_CODEX_HOOKS.map(/** Map one item. */ (h) => h.event).sort());
  assert.ok(once.hooks.PreToolUse[0].hooks[0].command.includes(SUMO_CODEX_SENTINEL));
  assert.equal(once.hooks.PreToolUse[0].hooks[0].type, 'command');
  assert.equal(once.hooks.PreToolUse[0].matcher, undefined);
  assert.equal(once.hooks.PermissionRequest[0].matcher, undefined);
  assert.equal(once.hooks.PreCompact[0].matcher, 'manual|auto');
  assert.equal(once.hooks.SubagentStop[0].hooks[0].command.includes('SubagentStop'), true);
});

test('reconcile preserves foreign Codex hooks; uninstall restores them', /** Verify reconcile preserves foreign Codex hooks; uninstall restores them. */ () => {
  const before = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-codex-hook' }] }] } };
  const after = reconcileCodexHooks(before);
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'foreign-codex-hook'));
  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command.includes(SUMO_CODEX_SENTINEL)));
  const restored = stripCodexHooks(after);
  assert.deepEqual(restored, before);
});

test('reconcile replaces stale Sumo entries and preserves malformed foreign buckets', /** Verify reconcile replaces stale Sumo entries and preserves malformed foreign buckets. */ () => {
  const before = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `old ${SUMO_CODEX_SENTINEL}` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-codex-hook' }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: `stale ${SUMO_CODEX_SENTINEL}` }] }],
      PostToolUse: 'not-an-array'
    }
  };
  const after = reconcileCodexHooks(before, [{ event: 'PreToolUse', matcher: 'Bash', safety: true, timeout: 5 }], {
    bin: 'node /tmp/sumo/cli.mjs forward codex'
  });

  assert.ok(after.hooks.PreToolUse.some(/** Test whether an item matches. */ (e) => e.hooks[0].command === 'foreign-codex-hook'));
  const sumo = after.hooks.PreToolUse.find(/** Find a matching item. */ (e) => e.hooks[0].command.includes(SUMO_CODEX_SENTINEL));
  assert.ok(sumo.hooks[0].command.startsWith('node /tmp/sumo/cli.mjs forward codex PreToolUse --safety'));
  assert.equal(sumo.hooks[0].timeout, 5);
  assert.equal(after.hooks.Stop, undefined);
  assert.equal(after.hooks.PostToolUse, 'not-an-array');
});

test('strip handles absent and malformed Codex hook config without touching foreign data', /** Verify strip handles absent and malformed Codex hook config without touching foreign data. */ () => {
  assert.deepEqual(stripCodexHooks({ model: 'gpt-5' }), { model: 'gpt-5' });
  assert.deepEqual(stripCodexHooks({ hooks: 'not-an-object' }), { hooks: 'not-an-object' });
  assert.deepEqual(stripCodexHooks({ hooks: { PreToolUse: 'foreign-invalid' } }), { hooks: { PreToolUse: 'foreign-invalid' } });
});

test('file round-trip: install writes .codex/hooks.json, re-run no-op, uninstall reverts', /** Verify file round-trip: install writes .codex/hooks.json, re-run no-op, uninstall reverts. */ () => {
  const dir = mkDir();
  const r1 = installCodexHooks({ projectDir: dir, env: {} });
  assert.equal(r1.changed, true);
  assert.ok(fs.existsSync(codexHooksPath(dir)));
  const r2 = installCodexHooks({ projectDir: dir, env: {} });
  assert.equal(r2.changed, false);
  const u = uninstallCodexHooks({ projectDir: dir });
  assert.equal(u.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(codexHooksPath(dir), 'utf8')), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reports current Codex hooks feature status without recommending the retired codex_hooks flag', /** Verify reports current Codex hooks feature status without recommending the retired codex_hooks flag. */ () => {
  const dir = mkDir();
  const r = installCodexHooks({ projectDir: dir, env: { CODEX_HOME: dir } }); // current Codex defaults hooks on.
  assert.equal(r.featureEnabled, true);
  assert.deepEqual(r.warnings, []);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(codexConfigTomlPath({ CODEX_HOME: dir }), '[features]\nhooks = false\n');
  assert.equal(codexHooksEnabled({ CODEX_HOME: dir }), false);
  const off = installCodexHooks({ projectDir: dir, env: { CODEX_HOME: dir } });
  assert.equal(off.featureEnabled, false);
  assert.match(off.warnings[0], /hooks/);
  assert.doesNotMatch(off.warnings[0], /codex_hooks/);

  fs.writeFileSync(codexConfigTomlPath({ CODEX_HOME: dir }), 'features.hooks = true\n');
  assert.equal(codexHooksEnabled({ CODEX_HOME: dir }), true);
  const dotted = installCodexHooks({ projectDir: dir, env: { CODEX_HOME: dir } });
  assert.equal(dotted.featureEnabled, true);
  assert.deepEqual(dotted.warnings, []);

  fs.writeFileSync(codexConfigTomlPath({ CODEX_HOME: dir }), '[features]\n# comment\nhooks = true\n');
  assert.equal(codexHooksEnabled({ CODEX_HOME: dir }), true);
  fs.writeFileSync(codexConfigTomlPath({ CODEX_HOME: dir }), '[features]\ncodex_hooks = true\n');
  assert.equal(codexHooksEnabled({ CODEX_HOME: dir }), true, 'legacy feature key remains accepted for older Codex installs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file round-trip reports malformed Codex hooks without overwriting them', /** Verify file round-trip reports malformed Codex hooks without overwriting them. */ () => {
  const dir = mkDir();
  fs.mkdirSync(path.dirname(codexHooksPath(dir)), { recursive: true });
  fs.writeFileSync(codexHooksPath(dir), '{ invalid json');

  const r = installCodexHooks({ projectDir: dir, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CONFIG_INVALID');
  assert.equal(fs.readFileSync(codexHooksPath(dir), 'utf8'), '{ invalid json');

  const u = uninstallCodexHooks({ projectDir: dir });
  assert.equal(u.ok, false);
  assert.equal(u.code, 'SUMO_CONFIG_INVALID');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('default Codex binary resolution prefers the npm-managed package over PATH shims', /** Verify default Codex binary resolution prefers the npm-managed package over PATH shims. */ () => {
  const dir = mkDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'codex.js');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));

  assert.equal(resolveCodexBin('codex', { CODEX_MANAGED_PACKAGE_ROOT: dir }), bin);
  assert.doesNotMatch(resolveCodexBin('codex', { CODEX_MANAGED_PACKAGE_ROOT: dir }), /[\\/]shims[\\/]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('explicit Codex binary config is honored', /** Verify explicit Codex binary config is honored. */ () => {
  assert.equal(resolveCodexBin('/tmp/custom-codex', {}), '/tmp/custom-codex');
  assert.equal(resolveCodexBin('codex', { SUMO_CODEX_BIN: '/tmp/env-codex' }), '/tmp/env-codex');
});
