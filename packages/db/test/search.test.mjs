import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLevel } from 'memory-level';

import { createSearch } from '../src/search.mjs';
import { evtKey } from '../src/keyspace.mjs';

/** Implement freshDb. */ function freshDb() {
  return new MemoryLevel({ valueEncoding: 'json' });
}

test('search index replaces existing docs and rebuilds from the event log', /** Verify search index replaces existing docs and rebuilds from the event log. */ async () => {
  const db = freshDb();
  const search = createSearch(db);

  search.index({ seq: 1, type: 'session.message' });
  search.index({ seq: 1, type: 'session.message', payload: { text: 'fresh needle' } });
  assert.equal((await search.query('needle')).length, 1);

  await db.put(evtKey(2), { seq: 2, type: 'session.message', payload: { text: 'rebuilt haystack' } });
  await search.rebuild();

  assert.deepEqual(await search.query('needle'), [], 'rebuild removes documents no longer in the log');
  const hits = await search.query('haystack', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docref, evtKey(2));
});
