import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, DiagnosticSchema, ErrorSchema } from '../src/schema.mjs';

test('config schemas validate defaults, populated configs, diagnostics and layer error codes', /** Verify config schemas validate defaults, populated configs, diagnostics and layer error codes. */ () => {
  const empty = ConfigSchema.safeParse({});
  assert.equal(empty.success, true);
  assert.equal(empty.data.root, false);
  assert.deepEqual(empty.data.use, []);
  assert.equal(empty.data.daemon.scope, 'project');
  assert.deepEqual(empty.data.plugins, {});

  const populated = ConfigSchema.safeParse({
    use: ['github', 'handoff'],
    storage: { path: '.sumo/db', retention: { rawDays: 14, eventDays: 90 } },
    daemon: { socket: '~/.sumo/sumo.sock', idleShutdown: '30m', scope: 'global' },
    harness: { default: 'claude-code', fallback: ['codex', 'cursor'] },
    orchestrator: { timeouts: { stall: '10m', nudge: true }, guards: { maxRounds: 7 } },
    plugins: { github: { repo: 'owner/name' } }
  });
  assert.equal(populated.success, true);
  assert.equal(populated.data.daemon.scope, 'global');
  assert.deepEqual(populated.data.harness.fallback, ['codex', 'cursor']);
  assert.equal(populated.data.orchestrator.timeouts.stall, '10m');

  const bad = ConfigSchema.safeParse({ root: 'yes', use: 'nope', daemon: { scope: 'planet' } });
  assert.equal(bad.success, false);
  assert.ok(bad.error.issues.length >= 3);
  assert.equal(ConfigSchema.safeParse({ daemon: { idleShutdown: 'half an hour' } }).success, false);

  const passthrough = ConfigSchema.safeParse({ plugins: { anything: { whatever: [1, 2, 3] } } });
  assert.equal(passthrough.success, true);
  assert.deepEqual(passthrough.data.plugins.anything, { whatever: [1, 2, 3] });

  const diagnostic = DiagnosticSchema.parse({ code: 'SUMO_CONFIG_PARSE', message: 'boom' });
  assert.equal(diagnostic.severity, 'error');
  assert.deepEqual(diagnostic.source, {});

  for (const c of ['SUMO_CONFIG_NOT_FOUND', 'SUMO_CONFIG_READ', 'SUMO_CONFIG_PARSE', 'SUMO_CONFIG_INVALID', 'SUMO_PLUGIN_CONFIG_INVALID']) {
    assert.equal(ErrorSchema.safeParse(c).success, true);
  }
  assert.equal(ErrorSchema.safeParse('SUMO_NOPE').success, false);
});
