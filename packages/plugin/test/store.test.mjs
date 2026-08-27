import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from '../src/store.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

test('plugin storage namespaces isolate leaves, scans, delimiters, and ttl pointers', /** Verify plugin storage namespaces isolate leaves, scans, delimiters, and ttl pointers. */ async () => {
  const s = storage(ctx.db, 'test-gate', 'main');
  assert.equal(await s.get('repo'), undefined);
  await s.set('repo', { passed: true });
  assert.deepEqual(await s.get('repo'), { passed: true });
  await s.del('repo');
  assert.equal(await s.get('repo'), undefined);

  const docs = storage(ctx.db, 'kb', 'docs');
  await docs.set('a', 1);
  await docs.set('b', 2);
  const out = [];
  for await (const [k, v] of docs.scan()) out.push([k, v]);
  assert.deepEqual(out.sort(), [['a', 1], ['b', 2]]);

  const a = storage(ctx.db, 'plugin-a', 'ns');
  const b = storage(ctx.db, 'plugin-b', 'ns');
  await a.set('secret', 'A-only');
  assert.equal(await b.get('secret'), undefined); // different plugin segment
  const seen = [];
  for await (const [k] of b.scan()) seen.push(k);
  assert.deepEqual(seen, []);

  // Without segment encoding, store('a').scan('') would range over `kv:p:a:` and catch keys written
  // by store('a:b') (`kv:p:a:b:...`). Encoding `:`→`%3A` makes the namespaces disjoint prefixes.
  const prefixA = storage(ctx.db, 'p', 'a');
  const ab = storage(ctx.db, 'p', 'a:b');
  await prefixA.set('k', 'in-a');
  await ab.set('k', 'in-a:b');

  const aKeys = [];
  for await (const [k, v] of prefixA.scan()) aKeys.push([k, v]);
  assert.deepEqual(aKeys, [['k', 'in-a']]); // ONLY a's key, not a:b's

  const abKeys = [];
  for await (const [k, v] of ab.scan()) abKeys.push([k, v]);
  assert.deepEqual(abKeys, [['k', 'in-a:b']]);

  assert.equal(await prefixA.get('k'), 'in-a');
  assert.equal(await ab.get('k'), 'in-a:b');

  const delim = storage(ctx.db, 'p', 'ns');
  await delim.set('a:b:c', 'leaf');
  assert.equal(await delim.get('a:b:c'), 'leaf');
  const delimOut = [];
  for await (const [k, v] of delim.scan('a:')) delimOut.push([k, v]);
  assert.deepEqual(delimOut, [['a:b:c', 'leaf']]);

  const ttl = storage(ctx.db, 'p', 'ttl');
  await ttl.set('temp', 'x', { ttlMs: 60_000 });
  const pointers = [];
  for await (const [, target] of ctx.db.scan('ttl:')) pointers.push(target);
  assert.ok(pointers.some(/** Test whether an item matches. */ (t) => typeof t === 'string' && t.endsWith(':temp')));
});
