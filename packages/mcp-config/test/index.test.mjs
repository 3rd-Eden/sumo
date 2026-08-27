/** Tests the public MCP configuration reconciliation contract. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspect, reconcile } from 'sumo/mcp-config';

const server = {
  name: 'ux-guardrails',
  entry: { type: 'http', url: 'https://guardrails.example/mcp' },
  matches(entry) {
    return entry?.url === 'https://guardrails.example/mcp';
  }
};

/** Creates an isolated config path for one reconciliation scenario. */
function config(name) {
  return join(mkdtempSync(join(tmpdir(), 'sumo-mcp-config-')), name);
}

test('reconciles recognized aliases without changing foreign JSON servers', /** Validates a reversible, idempotent JSON repair. */ () => {
  const path = config('.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { old: server.entry, foreign: { command: 'other' } } }));

  const repaired = reconcile({ path, root: 'mcpServers', server });
  const parsed = JSON.parse(readFileSync(path, 'utf8'));

  assert.equal(repaired.changed, true);
  assert.equal(inspect({ path, root: 'mcpServers', server }).status, 'healthy');
  assert.deepEqual(parsed.mcpServers.foreign, { command: 'other' });
  assert.equal(reconcile({ path, root: 'mcpServers', server }).changed, false);
  assert.ok(repaired.backup);
});

test('refuses collisions and malformed configuration without overwriting either', /** Preserves user-managed unsafe configs. */ () => {
  const collision = config('.mcp.json');
  writeFileSync(collision, JSON.stringify({ mcpServers: { 'ux-guardrails': { command: 'unrelated' } } }));
  assert.equal(reconcile({ path: collision, root: 'mcpServers', server }).status, 'collision');

  const malformed = config('.mcp.json');
  writeFileSync(malformed, '{');
  assert.equal(reconcile({ path: malformed, root: 'mcpServers', server }).ok, false);
  assert.equal(readFileSync(malformed, 'utf8'), '{');

  const unreadable = config('directory.json');
  mkdirSync(unreadable);
  const unreadableResult = inspect({ path: unreadable, root: 'mcpServers', server });
  assert.equal(unreadableResult.code, 'SUMO_CONFIG_READ');
  assert.match(unreadableResult.reason, /could not read .*directory/);
});

test('reconciles TOML MCP configuration through its declared root', /** Verifies Codex-style TOML support. */ () => {
  const path = config('config.toml');
  const repaired = reconcile({ path, root: 'mcp_servers', server });
  assert.equal(repaired.status, 'healthy');
  assert.match(readFileSync(path, 'utf8'), /\[mcp_servers\.ux-guardrails\]/);
});
