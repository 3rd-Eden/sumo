/**
 * Cursor hook install/reconcile (spec 05/12/13): idempotent, foreign-preserving, reversible, with the
 * `.cursor/hooks.json` shape verified from Cursor's official docs + the captured config
 * (`{ version:1, hooks: { <event>: [ { command } ] } }` — a FLAT command list, unlike Claude/Codex).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_CURSOR_HOOKS, reconcileCursorHooks, stripCursorHooks, installCursorHooks, uninstallCursorHooks, cursorHooksPath, SUMO_CURSOR_SENTINEL } from '../src/install/cursor.mjs';

/** Implement mkDir. */ function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-curinst-')); }

test('reconcile is idempotent and writes version:1 + flat command entries', /** Verify reconcile is idempotent and writes version:1 + flat command entries. */ () => {
  const once = reconcileCursorHooks({});
  const twice = reconcileCursorHooks(once);
  assert.deepEqual(twice, once);
  assert.equal(once.version, 1);
  assert.deepEqual(Object.keys(once.hooks).sort(), [...DEFAULT_CURSOR_HOOKS].sort());
  assert.ok(once.hooks.beforeShellExecution[0].command.includes(SUMO_CURSOR_SENTINEL));
  assert.ok(once.hooks.preToolUse[0].command.includes('forward cursor preToolUse'));
  assert.ok(once.hooks.afterFileEdit[0].command.includes('forward cursor afterFileEdit'));
  assert.ok(once.hooks.stop[0].command.includes('forward cursor stop'));
  assert.ok(once.hooks.workspaceOpen[0].command.includes('forward cursor workspaceOpen'));
});

test('reconcile preserves foreign Cursor hooks; uninstall restores them', /** Verify reconcile preserves foreign Cursor hooks; uninstall restores them. */ () => {
  const before = { version: 1, hooks: { beforeShellExecution: [{ command: 'foreign-cursor-hook' }] } };
  const after = reconcileCursorHooks(before);
  assert.ok(after.hooks.beforeShellExecution.some(/** Test whether an item matches. */ (e) => e.command === 'foreign-cursor-hook'));
  assert.ok(after.hooks.beforeShellExecution.some(/** Test whether an item matches. */ (e) => e.command.includes(SUMO_CURSOR_SENTINEL)));
  const restored = stripCursorHooks(after);
  assert.deepEqual(restored, before);
});

test('reconcile replaces stale Sumo commands and supports event objects', /** Verify reconcile replaces stale Sumo commands and supports event objects. */ () => {
  const before = {
    hooks: {
      beforeShellExecution: [
        { command: `old ${SUMO_CURSOR_SENTINEL}` },
        { command: 'foreign-cursor-hook' }
      ],
      afterShellExecution: [{ command: `stale ${SUMO_CURSOR_SENTINEL}` }],
      afterFileEdit: 'not-an-array'
    }
  };
  const after = reconcileCursorHooks(before, [{ event: 'beforeShellExecution', safety: true }], {
    bin: 'node /tmp/sumo/cli.mjs forward cursor'
  });

  assert.equal(after.version, 1);
  assert.ok(after.hooks.beforeShellExecution.some(/** Test whether an item matches. */ (e) => e.command === 'foreign-cursor-hook'));
  const sumo = after.hooks.beforeShellExecution.find(/** Find a matching item. */ (e) => e.command.includes(SUMO_CURSOR_SENTINEL));
  assert.ok(sumo.command.startsWith('node /tmp/sumo/cli.mjs forward cursor beforeShellExecution --safety'));
  assert.equal(after.hooks.afterShellExecution, undefined);
  assert.equal(after.hooks.afterFileEdit, 'not-an-array');
});

test('strip handles absent and malformed Cursor hook config without touching foreign data', /** Verify strip handles absent and malformed Cursor hook config without touching foreign data. */ () => {
  assert.deepEqual(stripCursorHooks({ theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(stripCursorHooks({ hooks: 'not-an-object' }), { hooks: 'not-an-object' });
  assert.deepEqual(stripCursorHooks({ hooks: { beforeShellExecution: 'foreign-invalid' } }), { hooks: { beforeShellExecution: 'foreign-invalid' } });
});

test('file round-trip: install writes .cursor/hooks.json, re-run no-op, uninstall reverts', /** Verify file round-trip: install writes .cursor/hooks.json, re-run no-op, uninstall reverts. */ () => {
  const dir = mkDir();
  const r1 = installCursorHooks({ projectDir: dir });
  assert.equal(r1.changed, true);
  const written = JSON.parse(fs.readFileSync(cursorHooksPath(dir), 'utf8'));
  assert.equal(written.version, 1);
  assert.ok(written.hooks.beforeShellExecution[0].command.includes('forward cursor beforeShellExecution'));
  const r2 = installCursorHooks({ projectDir: dir });
  assert.equal(r2.changed, false);
  const u = uninstallCursorHooks({ projectDir: dir });
  assert.equal(u.changed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file round-trip reports malformed Cursor hooks without overwriting them', /** Verify file round-trip reports malformed Cursor hooks without overwriting them. */ () => {
  const dir = mkDir();
  fs.mkdirSync(path.dirname(cursorHooksPath(dir)), { recursive: true });
  fs.writeFileSync(cursorHooksPath(dir), '{ invalid json');

  const r = installCursorHooks({ projectDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CONFIG_INVALID');
  assert.equal(fs.readFileSync(cursorHooksPath(dir), 'utf8'), '{ invalid json');

  const u = uninstallCursorHooks({ projectDir: dir });
  assert.equal(u.ok, false);
  assert.equal(u.code, 'SUMO_CONFIG_INVALID');
  fs.rmSync(dir, { recursive: true, force: true });
});
