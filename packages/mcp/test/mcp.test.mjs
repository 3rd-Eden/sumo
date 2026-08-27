/**
 * The MCP generator, exercised against a REAL MCP `Client` over the SDK's in-memory linked transport
 * (no faked client/transport — CONVENTIONS §5). Proves the catalog projects to tools and that a tool
 * call routes back through `runtime.invoke(..., { surface:'mcp' })` to the one `exec`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { plugin, create } from 'sumo/plugin';
import { create as createMcpServer, serve } from 'sumo/mcp';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
let runtime;
let client;

before(/** Run the before hook. */ async () => {
  ctx = await openTempDb();
  runtime = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  /** Implement demo. */ function demo(sumo) {
    sumo.command(
      create({
        name: 'greet',
        title: 'Greet',
        description: 'say hello to someone',
        inputSchema: z.object({ who: z.string() }),
        outputSchema: z.object({ hello: z.string() }),
        /** Implement exec. */ exec(input) { return ({ hello: input.who }); }
      })
    );
    sumo.command(
      create({
        name: 'internal-only',
        title: 'Internal',
        description: 'not for MCP',
        surfaces: ['programmatic'],
        /** Implement exec. */ exec() { return 'secret'; }
      })
    );
    // A capability whose input/output schemas are NOT root objects — valid for Sumo, but its MCP
    // projection must degrade rather than emit a tool the SDK client would reject.
    sumo.command(
      create({
        name: 'weird-schemas',
        title: 'Weird',
        description: 'non-object schemas',
        inputSchema: z.string(),
        outputSchema: z.array(z.string()),
        /** Implement exec. */ exec() { return ['a', 'b']; }
      })
    );
    // Returns a non-plain object (Date) — must travel as text, never as structuredContent.
    sumo.command(
      create({
        name: 'clock',
        title: 'Clock',
        description: 'returns a Date',
        /** Implement exec. */ exec() { return new Date('2026-06-24T00:00:00.000Z'); }
      })
    );
    sumo.command(
      create({
        name: 'noop',
        title: 'Noop',
        description: 'returns no value',
        /** Implement exec. */ exec() {}
      })
    );
    sumo.command(
      create({
        name: 'warn-only',
        title: 'Warn Only',
        description: 'emits a warning and returns no value',
        /** Implement exec. */ exec(_input, ctx) {
          ctx.warn({ code: 'SUMO_MCP_TEST_WARNING', message: 'heads up' });
        }
      })
    );
    sumo.command(
      create({
        name: 'warn-empty-string',
        title: 'Warn Empty String',
        description: 'emits an unshaped warning and returns a string',
        /** Implement exec. */ exec(_input, ctx) {
          ctx.warn({});
          return 'plain string result';
        }
      })
    );
    sumo.command(
      create({
        name: 'warn-fail',
        title: 'Warn Fail',
        description: 'emits a warning and returns a failure Result',
        /** Implement exec. */ exec(_input, ctx) {
          ctx.warn({ code: 'SUMO_MCP_TEST_WARNING', message: 'heads up' });
          return { ok: false, code: 'SUMO_MCP_TEST_FAIL', reason: 'nope' };
        }
      })
    );
    sumo.command(
      create({
        name: 'warn-fail-empty',
        title: 'Warn Fail Empty',
        description: 'emits an unshaped warning and returns a failure Result',
        /** Implement exec. */ exec(_input, ctx) {
          ctx.warn({});
          return { ok: false, code: 'SUMO_MCP_TEST_FAIL', reason: 'empty warning' };
        }
      })
    );
    sumo.command(
      create({
        name: 'print-and-return',
        title: 'Print And Return',
        description: 'prints progress and returns structured data',
        /** Implement exec. */ exec(_input, ctx) {
          ctx.print('progress: started');
          return { done: true };
        }
      })
    );
  }
  demo.sumo = { name: 'demo' };
  runtime.sumo.use(demo);
  await runtime.start();

  const server = createMcpServer(runtime, { name: 'sumo-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(/** Run the after hook. */ async () => {
  await client?.close();
  await runtime?.stop();
  await closeTempDb(ctx);
});

test('default server identity uses the package version', /** Verify the package version is the default MCP identity. */ async () => {
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const peer = new Client({ name: 'version-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), peer.connect(clientTransport)]);
    assert.deepEqual(peer.getServerVersion(), { name: 'sumo', version: '1.1.0' });
  } finally {
    await peer.close();
    await server.close();
  }
});

test('ListTools projects mcp-surfaced capabilities, omitting programmatic-only ones', /** Verify ListTools projects mcp-surfaced capabilities, omitting programmatic-only ones. */ async () => {
  const { tools } = await client.listTools();
  const names = tools.map(/** Map one item. */ (t) => t.name);
  assert.ok(names.includes('greet'), 'greet is exposed');
  assert.equal(names.includes('internal-only'), false, 'programmatic-only capability is not an MCP tool');

  const greet = tools.find(/** Find a matching item. */ (t) => t.name === 'greet');
  assert.equal(greet.description, 'say hello to someone');
  assert.equal(greet.inputSchema.type, 'object');
  assert.equal(greet.inputSchema.properties.who.type, 'string');
  assert.equal(greet.outputSchema.type, 'object');
});

test('CallTool routes through invoke and returns text + structuredContent', /** Verify CallTool routes through invoke and returns text + structuredContent. */ async () => {
  const res = await client.callTool({ name: 'greet', arguments: { who: 'ada' } });
  assert.equal(res.isError ?? false, false);
  assert.deepEqual(res.structuredContent, { hello: 'ada' });
  assert.equal(res.content[0].type, 'text');
  assert.match(res.content[0].text, /ada/);

  const printed = await client.callTool({ name: 'print-and-return', arguments: {} });
  assert.equal(printed.isError ?? false, false);
  assert.deepEqual(printed.structuredContent, { done: true });
  assert.match(printed.content[0].text, /progress: started/);
  assert.match(printed.content[0].text, /"done": true/);
});

test('CallTool with invalid input surfaces SUMO_COMMAND_INPUT_INVALID as isError', /** Verify CallTool with invalid input surfaces SUMO_COMMAND_INPUT_INVALID as isError. */ async () => {
  const res = await client.callTool({ name: 'greet', arguments: { who: 42 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /SUMO_COMMAND_INPUT_INVALID/);
});

test('CallTool for an unknown tool surfaces SUMO_NO_COMMAND as isError', /** Verify CallTool for an unknown tool surfaces SUMO_NO_COMMAND as isError. */ async () => {
  const res = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /SUMO_NO_COMMAND/);
});

test('CallTool for a programmatic-only capability is gated with SUMO_SURFACE_UNSUPPORTED', /** Verify CallTool for a programmatic-only capability is gated with SUMO_SURFACE_UNSUPPORTED. */ async () => {
  // The client cannot discover it (not in ListTools), but a direct call must still be refused.
  const res = await client.callTool({ name: 'internal-only', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /SUMO_SURFACE_UNSUPPORTED/);
});

test('ListTools degrades non-object schemas to a valid open object input (and omits non-object output)', /** Verify ListTools degrades non-object schemas to a valid open object input (and omits non-object output). */ async () => {
  // A real SDK Client validates the ListTools result; this would throw if the schema were invalid.
  const { tools } = await client.listTools();
  const weird = tools.find(/** Find a matching item. */ (t) => t.name === 'weird-schemas');
  assert.ok(weird, 'weird-schemas is still exposed');
  assert.equal(weird.inputSchema.type, 'object', 'non-object input degraded to open object');
  assert.equal('outputSchema' in weird, false, 'non-object output schema omitted');
});

test('a Date return is sent as text, not structuredContent (no protocol error)', /** Verify a Date return is sent as text, not structuredContent (no protocol error). */ async () => {
  const res = await client.callTool({ name: 'clock', arguments: {} });
  assert.equal(res.isError ?? false, false);
  assert.equal('structuredContent' in res, false, 'a Date does not become structuredContent');
  assert.match(res.content[0].text, /2026-06-24/);
});

test('CallTool with no value renders ok and carries warnings as MCP text', /** Verify CallTool with no value renders ok and carries warnings as MCP text. */ async () => {
  const noop = await client.callTool({ name: 'noop', arguments: {} });
  assert.equal(noop.isError ?? false, false);
  assert.equal(noop.content[0].text, 'ok');

  const warned = await client.callTool({ name: 'warn-only', arguments: {} });
  assert.equal(warned.isError ?? false, false);
  assert.match(warned.content[0].text, /ok/);
  assert.match(warned.content[0].text, /SUMO_MCP_TEST_WARNING: heads up/);

  const emptyWarn = await client.callTool({ name: 'warn-empty-string', arguments: {} });
  assert.equal(emptyWarn.isError ?? false, false);
  assert.match(emptyWarn.content[0].text, /plain string result/);
  assert.match(emptyWarn.content[0].text, /SUMO:/);

  const failed = await client.callTool({ name: 'warn-fail', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /SUMO_MCP_TEST_FAIL: nope/);
  assert.match(failed.content[0].text, /SUMO_MCP_TEST_WARNING: heads up/);

  const failedEmptyWarn = await client.callTool({ name: 'warn-fail-empty', arguments: {} });
  assert.equal(failedEmptyWarn.isError, true);
  assert.match(failedEmptyWarn.content[0].text, /SUMO_MCP_TEST_FAIL: empty warning/);
  assert.match(failedEmptyWarn.content[0].text, /SUMO:/);
});

test('initialize response includes server instructions', /** Verify initialize response includes server instructions. */ () => {
  const text = client.getInstructions();
  assert.ok(typeof text === 'string' && text.length > 0, 'instructions string is present');
  assert.ok(text.includes('Sumo'), 'instructions mention Sumo');
});

test('serve resolves the disconnect signal via server.onclose when the client disconnects', /** Verify serve resolves the disconnect signal via server.onclose when the client disconnects. */ async () => {
  // Mirrors the `sumo mcp` lifecycle: a separate server whose onclose fires on transport close so
  // the command can fall through to its `finally` and stop the runtime.
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = await serve(runtime, { name: 'lifecycle', version: '0.0.0', transport: st });
  const closed = new Promise(/** Run the callback. */ (resolve) => { server.onclose = /** Run the callback. */ () => resolve('closed'); });
  const peer = new Client({ name: 'peer', version: '0.0.0' });
  await peer.connect(ct);
  await peer.close();
  assert.equal(await closed, 'closed');
});
