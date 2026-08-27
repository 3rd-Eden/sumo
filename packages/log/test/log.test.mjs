import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('logger is shared and logError normalizes common error shapes', /** Verify logger is shared and logError normalizes common error shapes. */ async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'sumo-log-test-'));
  const savedHome = process.env.SUMO_HOME;
  const savedLevel = process.env.SUMO_LOG_LEVEL;
  process.env.SUMO_HOME = home;
  process.env.SUMO_LOG_LEVEL = 'debug';

  try {
    const { logger, logError } = await import('../src/index.mjs');
    const first = logger();
    assert.equal(logger(), first);
    assert.equal(first.level, 'debug');

    logError(new Error('boom'), {
      source: 'error'
    });
    logError({
      message: 'plain object',
      code: 'SUMO_TEST'
    }, {
      source: 'object'
    });
    logError({
      reason: 'json reason',
      toJSON: /** Serialize this error. */ () => ({
        reason: 'json reason',
        code: 'SUMO_JSON'
      })
    }, {
      source: 'json'
    });
    logError('string failure', {
      source: 'string'
    });
    logError(null, {
      source: 'null'
    });
  } finally {
    if (savedHome === undefined) delete process.env.SUMO_HOME; else process.env.SUMO_HOME = savedHome;
    if (savedLevel === undefined) delete process.env.SUMO_LOG_LEVEL; else process.env.SUMO_LOG_LEVEL = savedLevel;
  }
});
