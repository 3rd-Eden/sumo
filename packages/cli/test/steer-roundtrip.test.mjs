/**
 * Step 2 (spec 12): the full steer round-trip over the real socket against the co-hosted daemon —
 * `client.steer → control socket → onSteer → project runtime.steer → before('tool') waterfall →
 * {event}|{deny}` — using the engine's EXISTING decision contract (no SumoDecisionIntent yet).
 *
 * Also the real-runtime no-config-bleed proof: two project dirs with DIFFERENT plugins
 * must yield each project's OWN decision, never the other's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { open } from 'sumo/db';
import { startSteeringDaemon } from '../src/daemon-host.mjs';

/** Implement mkHome. */ function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-rt-home-')); }

/** Write a temp project: an isolating `sumo.yml` (`root: true`) + a one-line `before('tool')` plugin. */
function mkProject(name, pluginBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sumo-rt-${name}-`));
  fs.writeFileSync(path.join(dir, 'sumo.yml'), "root: true\nuse:\n  - './plugin.mjs'\n");
  fs.writeFileSync(path.join(dir, 'plugin.mjs'), `export default function gate(sumo) {\n  sumo.before('tool', ${pluginBody});\n}\n`);
  return dir;
}

test('steer round-trips to the right project runtime and returns {deny}/{event} — no config bleed', /** Verify steer round-trips to the right project runtime and returns {deny}/{event} — no config bleed. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const denier = mkProject('deny', "(e) => ({ deny: 'A blocks ' + e.payload.tool.name })");
  const modifier = mkProject('mod', "(e) => ({ event: { tag: 'B-saw-it' } })");

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  // Project A's plugin denies.
  const a = await db.steer({ harness: 'claude-code', cwd: denier, action: 'tool', payload: { tool: { name: 'Bash' } } });
  assert.ok('deny' in a, 'A should deny');
  assert.match(a.deny, /A blocks Bash/);

  // Project B's plugin passes a modify — its OWN decision, not A's deny (no bleed).
  const b = await db.steer({ harness: 'claude-code', cwd: modifier, action: 'tool', payload: { tool: { name: 'Bash' } } });
  assert.ok('event' in b, 'B should not deny');
  assert.equal(b.event.tag, 'B-saw-it');

  // Re-steer A: still A's decision (warm runtime stayed isolated).
  const a2 = await db.steer({ harness: 'claude-code', cwd: denier, action: 'tool', payload: { tool: { name: 'Edit' } } });
  assert.match(a2.deny, /A blocks Edit/);

  await db.close();
  await steering.close();
  for (const d of [home, denier, modifier]) fs.rmSync(d, { recursive: true, force: true });
});

test('a project with no decision hook passes the action through unchanged', /** Verify a project with no decision hook passes the action through unchanged. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home };
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-rt-pass-'));
  fs.writeFileSync(path.join(proj, 'sumo.yml'), 'root: true\n'); // no plugins

  const steering = await startSteeringDaemon({ home, idleShutdownMs: 0, projectIdleMs: 0, env, ingest: false });
  const db = await open({ home, autostart: false });

  const r = await db.steer({ harness: 'claude-code', cwd: proj, action: 'tool', payload: { tool: { name: 'Bash' } } });
  assert.ok('event' in r, 'no hook → pass through as {event}');
  assert.equal(r.event.payload.tool.name, 'Bash');

  await db.close();
  await steering.close();
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});

test('startSteeringDaemon starts and stops the real ingest service when ingestion is enabled', /** Verify startSteeringDaemon exercises the daemon-hosted ingest service lifecycle when ingestion is enabled. */ async () => {
  const home = mkHome();
  const env = { ...process.env, SUMO_HOME: home, SUMO_INGEST: '1' };
  const steering = await startSteeringDaemon({
    home,
    idleShutdownMs: 0,
    projectIdleMs: 25,
    readyBudgetMs: 25,
    env,
    ingest: true
  });
  const db = await open({ home, autostart: false });

  try {
    await db.put('daemon-host-ingest', { ok: true });
    assert.deepEqual(await db.get('daemon-host-ingest'), { ok: true });
  } finally {
    await db.close();
    await steering.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
