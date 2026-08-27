import { test } from 'node:test';
import assert from 'node:assert/strict';

import sumoDefault, { sumo } from './index.mjs';

test('root package exports the default registration facade', /** Verify the root registration facade. */ () => {
  assert.equal(sumoDefault, sumo);
  for (const verb of ['use', 'on', 'before', 'command', 'skill', 'run', 'store', 'install', 'harness', 'messenger', 'destroy', 'emit']) {
    assert.equal(typeof sumo[verb], 'function', `${verb} is available`);
  }
});
