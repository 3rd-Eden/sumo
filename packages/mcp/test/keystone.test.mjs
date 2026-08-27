/**
 * THE KEYSTONE PROOF (spec 16): one capability is defined ONCE, and the CLI generator, the MCP
 * generator, and the programmatic `invoke()` are GENERATED projections of it — all three reach the
 * same `exec` and produce the same result. There is no front door with behaviour the others lack.
 *
 * Real components only (CONVENTIONS §5): a real daemon-backed runtime, the real CLI dispatch path,
 * and a real MCP `Client` over the SDK's in-memory linked transport.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { plugin, create } from 'sumo/plugin';
import { create as createMcpServer } from 'sumo/mcp';
import { invoke } from 'sumo/cli';
import { buildCapabilityCommand, capabilityRows } from '../../cli/src/capabilities.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

/**
 * Drive the REAL CLI generator: build the commander command for a catalog entry, parse argv through
 * it, and route to `invoke` (surface:'cli') exactly as `main()` does. Returns the rendered Result.
 */
async function viaCli(runtime, entry, argv, out) {
  let code;
  const cmd = buildCapabilityCommand(entry, /** Run the callback. */ async (name, args) => {
    code = await invoke(name, args, { json: true }, { runtime, out });
  });
  const program = new Command('sumo').exitOverride();
  program.addCommand(cmd);
  await program.parseAsync([entry.name, ...argv], { from: 'user' });
  return code;
}

let ctx;
let runtime;
let client;

// ONE definition. Every surface below is generated from exactly this.
/** Implement defineDemo. */ function defineDemo(sumo) {
  sumo.command(
    create({
      name: 'square',
      title: 'Square',
      description: 'square a number',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ result: z.number() }),
      /** Implement exec. */ exec(input) { return ({ result: input.n * input.n }); }
    })
  );
}
defineDemo.sumo = { name: 'demo' };

before(/** Run the before hook. */ async () => {
  ctx = await openTempDb();
  runtime = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  runtime.sumo.use(defineDemo);
  await runtime.start();

  const server = createMcpServer(runtime, { name: 'sumo-keystone', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'keystone-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

after(/** Run the after hook. */ async () => {
  await client?.close();
  await runtime?.stop();
  await closeTempDb(ctx);
});

test('the one capability appears on all three surfaces', /** Verify the one capability appears on all three surfaces. */ async () => {
  // catalog (the single source of truth)
  const entry = runtime.capabilities().find(/** Find a matching item. */ (c) => c.name === 'square');
  assert.ok(entry, 'square is in the catalog');
  assert.deepEqual(entry.surfaces, ['cli', 'mcp', 'programmatic']);

  // CLI generator sees it
  assert.ok(capabilityRows(runtime).some(/** Test whether an item matches. */ (r) => r.command === 'square'));

  // MCP generator sees it
  const { tools } = await client.listTools();
  assert.ok(tools.some(/** Test whether an item matches. */ (t) => t.name === 'square'));
});

test('all three surfaces hit the same exec and produce the same value', /** Verify all three surfaces hit the same exec and produce the same value. */ async () => {
  const expected = { result: 49 };

  // 1) programmatic
  const prog = await runtime.invoke('square', { n: 7 }, { surface: 'programmatic' });
  assert.deepEqual(prog, { ok: true, value: expected });

  // 2) CLI — drive the REAL generator: argv → commander command → invoke(surface:'cli')
  const cliEntry = runtime.capabilities().find(/** Find a matching item. */ (c) => c.name === 'square');
  const lines = [];
  const code = await viaCli(runtime, cliEntry, ['--n', '7'], /** Run the callback. */ (l) => lines.push(l));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(lines.join('\n')).result, { ok: true, value: expected });

  // 3) MCP — real client tool call
  const mcp = await client.callTool({ name: 'square', arguments: { n: 7 } });
  assert.equal(mcp.isError ?? false, false);
  assert.deepEqual(mcp.structuredContent, expected);

  // identical across surfaces
  assert.deepEqual(prog.value, expected);
  assert.deepEqual(mcp.structuredContent, prog.value);
});

test('the same validation guards every surface (one inputSchema, applied once in invoke)', /** Verify the same validation guards every surface (one inputSchema, applied once in invoke). */ async () => {
  // programmatic
  assert.equal((await runtime.invoke('square', { n: 'x' })).code, 'SUMO_COMMAND_INPUT_INVALID');
  // CLI: commander coerces `--n x` to NaN; the SAME zod schema rejects it in invoke
  const cliEntry = runtime.capabilities().find(/** Find a matching item. */ (c) => c.name === 'square');
  const lines = [];
  const code = await viaCli(runtime, cliEntry, ['--n', 'x'], /** Run the callback. */ (l) => lines.push(l));
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines.join('\n')).result.code, 'SUMO_COMMAND_INPUT_INVALID');
  // MCP
  const mcp = await client.callTool({ name: 'square', arguments: { n: 'x' } });
  assert.equal(mcp.isError, true);
  assert.match(mcp.content[0].text, /SUMO_COMMAND_INPUT_INVALID/);
});
