/**
 * Step 7 (spec 12): decision-hook matchers. `before(action, fn, { match })` runs the handler only for
 * matching events; non-matching events skip it (engine-side filtering — `sumo forward` cannot match).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../src/engine.mjs';
import { toSteer } from '../src/received.mjs';
import { HandlerSchema } from '../src/schema.mjs';

/** Implement engineWith. */ function engineWith(handlers) {
  const e = registry({});
  for (const [action, fn, opts] of handlers) e.add('steer', action, fn, opts);
  return e;
}

/** Implement toolEvent. */ function toolEvent(name) { return toSteer({ action: 'tool', payload: { tool: { name } } }); }

test('decision-hook matchers filter real steer events through the engine', /** Verify decision-hook matchers filter real steer events through the engine. */ async () => {
  const stringMatch = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'no bash' }), { match: 'Bash' }]]);
  assert.deepEqual(await stringMatch.steer('tool', toolEvent('Bash')), { deny: 'no bash' });
  const passed = await stringMatch.steer('tool', toolEvent('Read'));
  assert.ok('event' in passed, 'non-matching tool skips the handler');
  const noTool = await stringMatch.steer('tool', toSteer({ action: 'tool', payload: {} }));
  assert.ok('event' in noTool, 'missing tool name skips the string matcher');

  const regexMatch = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'blocked' }), { match: /^(Bash|Shell)$/ }]]);
  assert.ok('deny' in (await regexMatch.steer('tool', toolEvent('Shell'))));
  assert.ok('event' in (await regexMatch.steer('tool', toolEvent('Edit'))));

  /** Implement matchRm. */ function matchRm(e) { return /rm\s+-rf/.test(e.payload?.tool?.input?.command ?? ''); }
  const predicateMatch = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'destructive' }), { match: matchRm }]]);
  const danger = toSteer({ action: 'tool', payload: { tool: { name: 'Bash', input: { command: 'rm -rf /' } } } });
  const safeEvent = toSteer({ action: 'tool', payload: { tool: { name: 'Bash', input: { command: 'ls' } } } });
  assert.ok('deny' in (await predicateMatch.steer('tool', danger)));
  assert.ok('event' in (await predicateMatch.steer('tool', safeEvent)));

  const globalRegex = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'no' }), { match: /Bash/g }]]);
  // Same input three times must match every time (a stateful /g/.test would alternate).
  for (let i = 0; i < 3; i++) assert.ok('deny' in (await globalRegex.steer('tool', toolEvent('Bash'))), `iteration ${i} must match`);

  /** Implement boom. */ function boom() { throw new Error('bad matcher'); }
  const safetyGuard = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'safety blocked' }), { match: boom, safety: true }]]);
  assert.deepEqual(await safetyGuard.steer('tool', toolEvent('Bash')), { deny: 'safety blocked' }, 'safety guard still runs');

  const nonSafe = engineWith([['tool', /** Run the callback. */ () => ({ deny: 'x' }), { match: boom }]]);
  assert.ok('event' in (await nonSafe.steer('tool', toolEvent('Bash'))), 'non-safety with a broken matcher is skipped');

  assert.throws(/** Run the callback. */ () => HandlerSchema.parse({ match: 123 }), /match must be/);
  assert.doesNotThrow(/** Run the callback. */ () => HandlerSchema.parse({ match: 'Bash' }));
  assert.doesNotThrow(/** Run the callback. */ () => HandlerSchema.parse({ match: /x/ }));
  assert.doesNotThrow(/** Run the callback. */ () => HandlerSchema.parse({ /** Implement match. */ match() { return true; } }));

  const unsupported = registry({});
  unsupported.add('steer', 'tool', /** Run the callback. */ () => ({ deny: 'should not run' }), { match: 123 });
  assert.ok('event' in (await unsupported.steer('tool', toolEvent('Bash'))));

  const waterfall = engineWith([
    ['tool', /** Run the callback. */ () => ({ deny: 'bash only' }), { match: 'Bash', priority: 200 }],
    ['tool', /** Run the callback. */ () => ({ event: { tagged: true } }), { priority: 100 }] // no match → always runs
  ]);
  // Read: first handler skipped, second runs → pass with tag.
  const read = await waterfall.steer('tool', toolEvent('Read'));
  assert.equal(read.event.tagged, true);
  // Bash: first handler matches → deny bails before the second.
  assert.deepEqual(await waterfall.steer('tool', toolEvent('Bash')), { deny: 'bash only' });
});
