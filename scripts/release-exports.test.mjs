import { test } from 'node:test';
import assert from 'node:assert/strict';

test('campsite rule is available through root package subpaths', async () => {
  const campsite = await import('sumo/plugins/campsite-rule');
  assert.equal(typeof campsite.CampsiteEngine, 'function');
  assert.match(import.meta.resolve('sumo/plugins/campsite-rule/bin'), /plugins\/campsite-rule\/bin\/hook\.js$/);
});
