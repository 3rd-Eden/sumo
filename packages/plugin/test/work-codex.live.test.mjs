/**
 * Live runtime proof for the `work -> sumo.run() -> reply` plugin path. The work item comes from the
 * reference HTTP messenger, and the backend under `sumo.run()` is the real built-in Codex harness
 * (`codex app-server`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Codex } from 'sumo/harness';
import { HttpMessenger, createHttpMessengerServer } from 'sumo/messenger/reference/http';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';
import { plugin } from '../src/runtime.mjs';
import { assertAvailable } from '../../harness/test/_live.mjs';

/** Implement httpWorkMessenger. */ function httpWorkMessenger(sumo) {
  sumo.messenger('http-reference', /** Run the callback. */ (mctx) => new HttpMessenger(mctx));
}

/** Implement promptFor. */ function promptFor(work) {
  return work.prompt ?? work.body ?? work.title;
}

/** Implement referenceWorkReply. */ function referenceWorkReply(medium, id) {
  return medium.getWork(id)?.replies[0]?.text;
}

/**
 * Plugin under test: it consumes a work item, spawns a real Codex session, waits for the first
 * assistant message, ends the session, and replies to the work source.
 * @param {any} sumo
 */
function codexWorkRunner(sumo) {
  sumo.on('work', /** Run the callback. */ async (work) => {
    const result = await sumo.run(promptFor(work), { harness: 'codex' });
    if (!result.ok) {
      await work.reply(`run failed: ${result.code}`);
      return;
    }

    const session = result.value;
    const timeout = setTimeout(/** Run the timer callback. */ () => {
      session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {});
    }, 60_000);
    try {
      let reply = '';
      for await (const event of session.join()) {
        if (event.ext?.classification?.code) {
          reply = `session failed: ${event.ext.classification.code}`;
          break;
        }
        if (event.type === 'session.message' && event.payload?.role === 'assistant') {
          reply = String(event.payload.text ?? '');
          break;
        }
        if (event.type === 'session.dead' || event.type === 'session.ended') break;
      }
      await session.end().catch(/** Handle the expected rejection. */ () => {});
      await session.done().catch(/** Handle the expected rejection. */ () => {});
      await work.reply(reply || 'session ended without assistant reply');
    } finally {
      clearTimeout(timeout);
      await session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {});
    }
  });
}

test('LIVE codex: plugin work handler uses the real backend and replies', { timeout: 120_000 }, /** Verify LIVE codex: plugin work handler uses the real backend and replies. */ async (t) => {
  const codexConfig = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!codexConfig) return;

  const ctx = await openTempDb();
  const medium = await createHttpMessengerServer();
  await medium.postWork({
    externalId: 'codex-work',
    title: 'Live Codex work',
    body: 'Reply with exactly: OK',
    cwd: ctx.home
  });
  const rt = plugin({
    cwd: ctx.home,
    flags: {},
    env: process.env,
    db: ctx.db,
    config: {
      harness: { default: 'codex', codex: codexConfig },
      plugins: { 'http-reference': { baseUrl: medium.baseUrl, settleMs: 0 } }
    }
  });
  try {
    rt.sumo
      .use(httpWorkMessenger)
      .use(codexWorkRunner);
    await rt.start();
    await rt.drainIngress();
    await waitUntil(/** Run the callback. */ () => referenceWorkReply(medium, 'codex-work') !== undefined, { timeoutMs: 90_000 });
    const reply = referenceWorkReply(medium, 'codex-work');
    if (/SUMO_(RATE_LIMITED|AUTH_REQUIRED|BUDGET_EXHAUSTED|BACKEND_UNAVAILABLE|OVERLOADED)/.test(reply)) {
      t.skip(`codex live prerequisite unavailable: ${reply}`);
      return;
    }
    assert.equal(reply, 'OK');
  } finally {
    await rt.stop().catch(/** Handle the expected rejection. */ () => {});
    await medium.close();
    await closeTempDb(ctx);
  }
});
