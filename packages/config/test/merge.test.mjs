import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, mergeChain } from '../src/merge.mjs';

test('mergeConfig and mergeChain preserve precedence, dedupe and immutability', /** Verify mergeConfig and mergeChain preserve precedence, dedupe and immutability. */ () => {
  const nested = mergeConfig(
    { storage: { path: 'a', retention: { rawDays: 14 } } },
    { storage: { retention: { eventDays: 90 } } }
  );
  assert.deepEqual(nested.storage, { path: 'a', retention: { rawDays: 14, eventDays: 90 } });
  assert.equal(mergeConfig({ harness: { default: 'a' } }, { harness: { default: 'b' } }).harness.default, 'b');
  assert.deepEqual(mergeConfig({ x: { a: 1 } }, { x: [1, 2] }).x, [1, 2]);
  assert.equal(mergeConfig({ x: [1, 2] }, { x: 'scalar' }).x, 'scalar');

  const arrays = mergeConfig(
    { plugins: { dependency: { sources: ['team', 'npm'] } } },
    { plugins: { dependency: { sources: ['npm', 'github'] } } }
  );
  assert.deepEqual(arrays.plugins.dependency.sources, ['team', 'npm', 'github']);
  assert.deepEqual(mergeConfig({ use: ['a', 'b'] }, { use: ['b', 'c'] }).use, ['a', 'b', 'c']);
  assert.deepEqual(mergeConfig({ use: ['a', 'noisy', 'b'] }, { use: ['~noisy'] }).use, ['a', 'b']);
  assert.deepEqual(mergeConfig({ use: ['a'] }, { use: ['~ghost', 'c'] }).use, ['a', 'c']);

  const earlier = { use: ['a'], plugins: { p: { k: 1 } } };
  const later = { use: ['b'], plugins: { p: { j: 2 } } };
  mergeConfig(earlier, later);
  assert.deepEqual(earlier, { use: ['a'], plugins: { p: { k: 1 } } });
  assert.deepEqual(later, { use: ['b'], plugins: { p: { j: 2 } } });

  const chained = mergeChain([
    { use: ['global'] },
    { use: ['parent', 'noisy'] },
    { use: ['~noisy', 'nearest'] }
  ]);
  assert.deepEqual(chained.use, ['global', 'parent', 'nearest']);
  assert.deepEqual(mergeChain([]), {});
});
