/**
 * Unit tests for the session state-query capabilities (the model-based-journey scorers) against a REAL
 * temp daemon with seeded `ses:` docs — no harness binary, no model call. Covers the false/edge cases
 * the live journey can't cheaply reach (the adversarial review's "thin coverage" finding): not-running,
 * missing model, model mismatch, not-completed, await timeout, and the transcript-correlated false
 * branches (no doc / no transcript path / path absent on disk).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { key, open } from 'sumo/db';
import { start } from 'sumo/db/daemon';
import { plugin } from 'sumo/plugin';
import { register } from 'sumo/session';
import { createSteerHost } from '../../cli/src/steer-host.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
let runtime;
let savedHome;

/** Invoke a capability on the programmatic surface and return the raw exec value (invoke wraps in ok()). */
async function call(name, args) {
  const r = await runtime.invoke(name, args, { surface: 'programmatic' });
  assert.equal(r.ok, true, `invoke ${name} failed: ${JSON.stringify(r)}`);
  return r.value;
}

/** Seed a ses: doc (only the fields these scorers read; SessionSchema requires id/harness/state/times). */
function seed(id, patch) {
  const now = 1_700_000_000_000;
  return ctx.db.put(key(id), {
    id,
    harness: 'claude-code',
    state: 'running',
    createdAt: now,
    updatedAt: now,
    ext: {},
    ...patch
  });
}

let evtN = 0;
/** Append one event to the log (the real event-log path; assigns the evt:<seq> the scorers scan). */
function seedEvent(sessionId, { type = 'session.message', role, nativeSessionId, payload, ext } = {}) {
  return ctx.db.append({
    dedupe: `seed:${sessionId}:${evtN++}`,
    type,
    sessionId,
    payload: payload ?? (role ? {
      role
    } : {}),
    ext: ext ?? (nativeSessionId ? {
      nativeSessionId
    } : {})
  });
}

before(/** Run the before hook. */ async () => {
  ctx = await openTempDb();
  // The capabilities open their own open({}) → process.env.SUMO_HOME; point it at the temp daemon.
  savedHome = process.env.SUMO_HOME;
  process.env.SUMO_HOME = ctx.home;
  runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: process.env,
    db: ctx.db
  });
  register(runtime.sumo);
  await runtime.start();
});

after(/** Run the after hook. */ async () => {
  await runtime?.stop();
  if (savedHome === undefined) delete process.env.SUMO_HOME; else process.env.SUMO_HOME = savedHome;
  await closeTempDb(ctx);
});

test('session-is-running: running + model recorded passes; mismatch/absent/ended fail', /** Verify session-is-running: running + model recorded passes; mismatch/absent/ended fail. */ async () => {
  await seed('ses_run1', {
    state: 'running',
    model: 'haiku'
  });
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run1'
  })).pass, true);
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run1',
    expectModel: 'haiku'
  })).pass, true);
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run1',
    expectModel: 'opus'
  })).pass, false, 'model mismatch fails');
  await seed('ses_run_tier', {
    state: 'running',
    model: 'gpt-5.4-mini',
    ext: {
      tier: 'fast',
      requested: 'fast'
    }
  });
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run_tier',
    expectTier: 'fast'
  })).pass, true);
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run_tier',
    expectTier: 'powerful'
  })).pass, false, 'tier mismatch fails');

  await seed('ses_run2', {
    state: 'running'
  }); // no model
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_run2'
  })).pass, false, 'no model recorded fails ()');

  await seed('ses_end1', {
    state: 'ended',
    model: 'haiku'
  });
  assert.equal((await call('session-is-running', {
    sessionId: 'ses_end1'
  })).pass, false, 'ended is not running');

  assert.equal((await call('session-is-running', {
    sessionId: 'ses_missing'
  })).pass, false, 'missing doc fails');
});

test('session-completed: ended passes, running/missing fail', /** Verify session-completed: ended passes, running/missing fail. */ async () => {
  await seed('ses_c_end', { state: 'ended' });
  await seed('ses_c_run', { state: 'running' });
  assert.equal((await call('session-completed', { sessionId: 'ses_c_end' })).pass, true);
  assert.equal((await call('session-completed', { sessionId: 'ses_c_run' })).pass, false);
  assert.equal((await call('session-completed', { sessionId: 'ses_missing' })).pass, false);
});

test('session-await-ended: returns terminal state; times out as a failed Result (not a throw)', /** Verify session-await-ended: returns terminal state; times out as a failed Result (not a throw). */ async () => {
  await seed('ses_a_end', {
    state: 'dead'
  });
  assert.deepEqual(await call('session-await-ended', {
    sessionId: 'ses_a_end'
  }), {
    sessionId: 'ses_a_end',
    state: 'dead'
  });

  await seed('ses_a_run', {
    state: 'running'
  });
  const timedOut = await call('session-await-ended', {
    sessionId: 'ses_a_run',
    timeoutMs: 300
  });
  assert.equal(timedOut.ok, false, 'timeout is a Result, not a throw (§3b)');
  assert.equal(timedOut.code, 'SUMO_VERIFY_FAILED');
});

test('session-events-correlated: passes only with a Sumo-keyed event carrying the native id', /** Verify session-events-correlated: passes only with a Sumo-keyed event carrying the native id. */ async () => {
  // keyed + native id present → correlated
  await seedEvent('ses_ev_ok', {
    type: 'session.started',
    nativeSessionId: 'native-abc'
  });
  assert.equal((await call('session-events-correlated', {
    sessionId: 'ses_ev_ok'
  })).pass, true);

  // keyed but no native id in ext → not correlated (a short budget keeps the poll quick)
  await seedEvent('ses_ev_nonat', {
    type: 'session.started'
  });
  assert.equal((await call('session-events-correlated', {
    sessionId: 'ses_ev_nonat',
    timeoutMs: 300
  })).pass, false, 'no native id fails');

  // no events keyed to this session at all → not correlated
  assert.equal((await call('session-events-correlated', {
    sessionId: 'ses_ev_none',
    timeoutMs: 300
  })).pass, false, 'no keyed events fails');
});

test('session-events-correlated: resolves from a delayed subscribed event', /** Verify session-events-correlated: resolves from a delayed subscribed event. */ async () => {
  const waiting = call('session-events-correlated', {
    sessionId: 'ses_ev_late',
    timeoutMs: 2000
  });
  setTimeout(/** Run the timer callback. */ () => {
    void seedEvent('ses_ev_late', {
      type: 'session.started',
      nativeSessionId: 'native-late'
    });
  }, 50);
  assert.equal((await waiting).pass, true);
});

test('session-native-id: surfaces { resumeId } from the doc; fails as a Result when absent', /** Verify session-native-id: surfaces { resumeId } from the doc; fails as a Result when absent. */ async () => {
  await seed('ses_nat_ok', {
    harnessSessionId: 'native-xyz'
  });
  assert.deepEqual(await call('session-native-id', {
    sessionId: 'ses_nat_ok'
  }), {
    resumeId: 'native-xyz'
  });

  await seed('ses_nat_none', {}); // no harnessSessionId
  const noNat = await call('session-native-id', {
    sessionId: 'ses_nat_none'
  });
  assert.equal(noNat.ok, false, 'no native id is a failed Result (§3b), not a throw');
  assert.equal(noNat.code, 'SUMO_VERIFY_FAILED');

  const missing = await call('session-native-id', {
    sessionId: 'ses_missing'
  });
  assert.equal(missing.ok, false, 'missing doc fails as a Result');
});

test('session-await-turn: returns once an assistant turn lands; times out as a failed Result', /** Verify session-await-turn: returns once an assistant turn lands; times out as a failed Result. */ async () => {
  await seedEvent('ses_turn_ok', {
    type: 'session.message',
    role: 'assistant'
  });
  assert.deepEqual(await call('session-await-turn', {
    sessionId: 'ses_turn_ok'
  }), {
    sessionId: 'ses_turn_ok',
    assistantMessages: 1
  });

  // a user-only message does not count as an assistant turn → times out
  await seedEvent('ses_turn_user', {
    type: 'session.message',
    role: 'user'
  });
  const timedOut = await call('session-await-turn', {
    sessionId: 'ses_turn_user',
    timeoutMs: 300
  });
  assert.equal(timedOut.ok, false, 'timeout is a Result, not a throw (§3b)');
  assert.equal(timedOut.code, 'SUMO_VERIFY_FAILED');
});

test('session-await-turn: resolves from a delayed subscribed assistant event', /** Verify session-await-turn: resolves from a delayed subscribed assistant event. */ async () => {
  const waiting = call('session-await-turn', {
    sessionId: 'ses_turn_late',
    timeoutMs: 2000
  });
  setTimeout(/** Run the timer callback. */ () => {
    void seedEvent('ses_turn_late', {
      type: 'session.message',
      role: 'assistant'
    });
  }, 50);
  assert.deepEqual(await waiting, {
    sessionId: 'ses_turn_late',
    assistantMessages: 1
  });
});

test('session-await-active-turn: returns once a turn-started event lands; times out as a failed Result', /** Verify session-await-active-turn: returns once a turn-started event lands; times out as a failed Result. */ async () => {
  await seedEvent('ses_active_ok', {
    type: 'session.turn-started',
    payload: {
      turnId: 'turn-1'
    }
  });
  assert.deepEqual(await call('session-await-active-turn', {
    sessionId: 'ses_active_ok'
  }), {
    sessionId: 'ses_active_ok',
    activeTurns: 1,
    turnId: 'turn-1'
  });

  const waiting = call('session-await-active-turn', {
    sessionId: 'ses_active_late',
    timeoutMs: 2000
  });
  setTimeout(/** Run the timer callback. */ () => {
    void seedEvent('ses_active_late', {
      type: 'session.turn-started'
    });
  }, 50);
  assert.deepEqual(await waiting, {
    sessionId: 'ses_active_late',
    activeTurns: 1
  });

  const timedOut = await call('session-await-active-turn', {
    sessionId: 'ses_active_none',
    timeoutMs: 300
  });
  assert.equal(timedOut.ok, false, 'timeout is a Result, not a throw (§3b)');
  assert.equal(timedOut.code, 'SUMO_VERIFY_FAILED');
});

test('session-await-turn-completed: can wait for any completed turn or one exact turn id', /** Verify session-await-turn-completed: can wait for any completed turn or one exact turn id. */ async () => {
  await seedEvent('ses_completed_any', {
    type: 'session.raw:turn.completed',
    ext: {
      native: {
        params: {
          turn: {
            id: 'turn-any',
            status: 'completed'
          }
        }
      }
    }
  });
  assert.deepEqual(await call('session-await-turn-completed', {
    sessionId: 'ses_completed_any'
  }), {
    sessionId: 'ses_completed_any',
    completedTurns: 1,
    turnId: 'turn-any',
    status: 'completed'
  });

  await seedEvent('ses_completed_unshaped', {
    type: 'session.raw:turn.completed',
    ext: {
      native: {
        params: {}
      }
    }
  });
  assert.deepEqual(await call('session-await-turn-completed', {
    sessionId: 'ses_completed_unshaped'
  }), {
    sessionId: 'ses_completed_unshaped',
    completedTurns: 1
  });

  const waiting = call('session-await-turn-completed', {
    sessionId: 'ses_completed_exact',
    turn: {
      id: 'turn-late'
    },
    timeoutMs: 2000
  });
  setTimeout(/** Run the timer callback. */ () => {
    void seedEvent('ses_completed_exact', {
      type: 'session.raw:turn.completed',
      ext: {
        native: {
          params: {
            turn: {
              id: 'turn-other',
              status: 'completed'
            }
          }
        }
      }
    });
    void seedEvent('ses_completed_exact', {
      type: 'session.raw:turn.completed',
      ext: {
        native: {
          params: {
            turn: {
              id: 'turn-late',
              status: 'interrupted'
            }
          }
        }
      }
    });
  }, 50);
  assert.deepEqual(await waiting, {
    sessionId: 'ses_completed_exact',
    completedTurns: 1,
    turnId: 'turn-late',
    status: 'interrupted'
  });

  const timedOut = await call('session-await-turn-completed', {
    sessionId: 'ses_completed_none',
    turnId: 'missing-turn',
    timeoutMs: 300
  });
  assert.equal(timedOut.ok, false, 'timeout is a Result, not a throw (§3b)');
  assert.equal(timedOut.code, 'SUMO_VERIFY_FAILED');

  const timedOutAny = await call('session-await-turn-completed', {
    sessionId: 'ses_completed_none',
    timeoutMs: 300
  });
  assert.equal(timedOutAny.ok, false, 'timeout without an exact turn is also a Result');
  assert.equal(timedOutAny.code, 'SUMO_VERIFY_FAILED');
});

test('session-await-turn-completed: surfaces classified live prerequisite failures instead of timing out', /** Verify session-await-turn-completed: surfaces classified live prerequisite failures instead of timing out. */ async () => {
  const waiting = call('session-await-turn-completed', {
    sessionId: 'ses_completed_auth',
    turnId: 'turn-auth',
    timeoutMs: 2000
  });
  setTimeout(/** Run the timer callback. */ () => {
    void seedEvent('ses_completed_auth', {
      type: 'session.raw:error',
      payload: {
        sumoCode: 'SUMO_AUTH_REQUIRED'
      },
      ext: {
        classification: {
          code: 'SUMO_AUTH_REQUIRED',
          retryable: false,
          fallback: true
        }
      }
    });
  }, 50);

  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUMO_AUTH_REQUIRED');
});

test('session control capabilities traverse the real daemon-hosted steer host', /** Verify session control capabilities traverse the real daemon-hosted steer host. */ async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-session-control-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-session-project-'));
  fs.writeFileSync(path.join(project, 'sumo.yml'), 'root: true\n');
  const previousHome = process.env.SUMO_HOME;
  let daemon;
  let db;
  let rt;
  let host;

  try {
    process.env.SUMO_HOME = home;
    host = createSteerHost({
      /** Implement inProcessClient. */ inProcessClient() { return daemon.inProcessClient(); },
      projectIdleMs: 0,
      env: process.env
    });
    daemon = await start({
      home,
      idleShutdownMs: 0,
      /** Implement onSession. */ onSession(req) { return host.onSession(req); }
    });
    db = await open({
      home,
      autostart: false
    });
    rt = plugin({
      cwd: project,
      flags: {},
      env: process.env,
      db
    });
    register(rt.sumo);
    await rt.start();

    const spawn = await rt.invoke('session-spawn', {
      prompt: 'hello',
      cwd: project,
      harness: 'definitely-missing-harness',
      model: 'model-from-command',
      reasoningEffort: 'high'
    }, { surface: 'programmatic' });
    assert.equal(spawn.ok, true);
    assert.equal(spawn.value.ok, false);
    assert.equal(spawn.value.code, 'SUMO_NO_HARNESS');

    const resume = await rt.invoke('session-resume', {
      resumeId: 'native-thread-id',
      prompt: 'continue',
      cwd: project,
      harness: 'definitely-missing-harness',
      model: 'model-from-command',
      reasoningEffort: 'low'
    }, { surface: 'programmatic' });
    assert.equal(resume.ok, true);
    assert.equal(resume.value.ok, false);
    assert.equal(resume.value.code, 'SUMO_NO_HARNESS');

    const defaultedSpawn = await rt.invoke('session-spawn', {
      prompt: 'hello from cwd default',
      harness: 'definitely-missing-harness'
    }, { surface: 'programmatic' });
    assert.equal(defaultedSpawn.ok, true);
    assert.equal(defaultedSpawn.value.ok, false);
    assert.equal(defaultedSpawn.value.code, 'SUMO_NO_HARNESS');

    const defaultedResume = await rt.invoke('session-resume', {
      resumeId: 'native-thread-id',
      harness: 'definitely-missing-harness'
    }, { surface: 'programmatic' });
    assert.equal(defaultedResume.ok, true);
    assert.equal(defaultedResume.value.ok, false);
    assert.equal(defaultedResume.value.code, 'SUMO_NO_HARNESS');

    const implicitHarnessResume = await rt.invoke('session-resume', {
      resumeId: 'native-thread-id',
      cwd: project
    }, { surface: 'programmatic' });
    assert.equal(implicitHarnessResume.ok, true);
    assert.equal(implicitHarnessResume.value.ok, false);
    assert.equal(implicitHarnessResume.value.code, 'SUMO_NO_HARNESS');

    for (const [name, args] of [
      [
        'session-cancel',
        {
          sessionId: 'ses_not_registered'
        }
      ],
      [
        'session-send',
        {
          sessionId: 'ses_not_registered',
          text: 'hi'
        }
      ],
      [
        'session-end',
        {
          sessionId: 'ses_not_registered',
          force: true
        }
      ]
    ]) {
      await assert.rejects(
        rt.invoke(name, args, { surface: 'programmatic' }),
        /** Run the callback. */ (err) => err.code === 'SUMO_SESSION_UNKNOWN'
      );
    }
  } finally {
    await rt?.stop();
    await db?.close();
    await host?.dispose();
    await daemon?.close();
    if (previousHome === undefined) delete process.env.SUMO_HOME; else process.env.SUMO_HOME = previousHome;
    fs.rmSync(home, {
      recursive: true,
      force: true
    });
    fs.rmSync(project, {
      recursive: true,
      force: true
    });
  }
});

test('session-transcript-correlated: false when no doc / no path / path absent on disk', /** Verify session-transcript-correlated: false when no doc / no path / path absent on disk. */ async () => {
  assert.equal((await call('session-transcript-correlated', {
    sessionId: 'ses_missing'
  })).pass, false);

  await seed('ses_tc_nopath', {
    state: 'ended',
    harnessSessionId: 'native-1'
  }); // no transcriptPath
  assert.equal((await call('session-transcript-correlated', {
    sessionId: 'ses_tc_nopath'
  })).pass, false);

  await seed('ses_tc_ghost', {
    state: 'ended',
    harnessSessionId: 'native-2',
    transcriptPath: '/nonexistent/native-2.jsonl'
  });
  assert.equal((await call('session-transcript-correlated', {
    sessionId: 'ses_tc_ghost'
  })).pass, false, 'path that does not resolve fails');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-session-transcript-invalid-'));
  try {
    const malformed = path.join(dir, 'native-3.jsonl');
    fs.writeFileSync(malformed, '{not json}\n');
    await seed('ses_tc_malformed', {
      state: 'ended',
      harnessSessionId: 'native-3',
      transcriptPath: malformed
    });
    await assert.rejects(/** Run the callback. */ () => call('session-transcript-correlated', {
      sessionId: 'ses_tc_malformed'
    }), SyntaxError);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});

test('session-transcript-correlated: validates naming, unknown acquirers, empty live streams and real fixture collapse', /** Verify session-transcript-correlated: validates naming, unknown acquirers, empty live streams and real fixture collapse. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-session-transcript-'));
  try {
    const nativeId = 'b06f2b01-de75-4950-b7c7-8011e0d74fc9';
    const fixture = path.resolve('packages/transcript/test/fixtures/claude-code/file/turn.jsonl');
    const transcriptPath = path.join(dir, `${nativeId}.jsonl`);
    fs.copyFileSync(fixture, transcriptPath);

    await seed('ses_tc_misnamed', {
      state: 'ended',
      harness: 'claude-code',
      harnessSessionId: nativeId,
      transcriptPath: path.join(dir, 'wrong-name.jsonl')
    });
    assert.equal((await call('session-transcript-correlated', {
      sessionId: 'ses_tc_misnamed'
    })).pass, false, 'native id must name the transcript file');

    await seed('ses_tc_unknown_harness', {
      state: 'ended',
      harness: 'unknown-acquirer',
      harnessSessionId: nativeId,
      transcriptPath
    });
    assert.equal((await call('session-transcript-correlated', {
      sessionId: 'ses_tc_unknown_harness'
    })).pass, false, 'correlation cannot pass when no acquirer can verify dual-source dedupe');

    await seed('ses_tc_no_live', {
      state: 'ended',
      harness: 'claude-code',
      harnessSessionId: nativeId,
      transcriptPath
    });
    assert.equal((await call('session-transcript-correlated', {
      sessionId: 'ses_tc_no_live'
    })).pass, false, 'no live assistant event means there is nothing to collapse');

    await seed('ses_tc_ok', {
      state: 'ended',
      harness: 'claude-code',
      harnessSessionId: nativeId,
      transcriptPath
    });
    await ctx.db.append({
      dedupe: 'msg:ses_tc_ok:msg_bdrk_01B57AC2GA8qsXxNerPeNSa9#0',
      type: 'session.message',
      sessionId: 'ses_tc_ok',
      payload: {
        role: 'assistant',
        text: 'HELLO'
      },
      ext: {
        nativeSessionId: nativeId,
        uuid: '258f8f75-7a03-4519-ada9-f1b29f4879fb'
      }
    });
    const correlated = await call('session-transcript-correlated', {
      sessionId: 'ses_tc_ok'
    });
    assert.equal(correlated.pass, true);
    assert.match(correlated.message, /collapsed when equal/);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
