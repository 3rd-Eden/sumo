import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { plugin, storage } from 'sumo/plugin';
import { Messenger } from 'sumo/messenger';
import { HttpMessenger, ReadOnlyHttpMessenger, createHttpMessengerServer } from 'sumo/messenger/reference/http';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement httpMessengerPlugin. */ function httpMessengerPlugin(options) {
  return /** Implement referenceHttpMessenger. */ function referenceHttpMessenger(sumo) {
    sumo.messenger('http-reference', /** Run the callback. */ (mctx) => new HttpMessenger({ ...mctx, config: options }));
  };
}

/** Implement collectIngress. */ async function collectIngress(adapter) {
  const works = [];
  for await (const work of adapter.ingress()) works.push(work);
  return works;
}

test('base Messenger abstract methods and unsupported operations fail honestly', /** Verify base Messenger abstract methods and unsupported operations fail honestly. */ async () => {
  const adapter = new Messenger();
  const ref = { id: 'work_base', externalId: 'base-1', ext: {} };

  await assert.rejects(/** Run the callback. */ () => adapter.work().next(), { code: 'SUMO_NOT_IMPLEMENTED' });
  await assert.rejects(/** Run the callback. */ () => adapter.say(ref, 'reply'), { code: 'SUMO_NOT_IMPLEMENTED' });
  await assert.rejects(/** Run the callback. */ () => adapter.mark(ref), { code: 'SUMO_NOT_IMPLEMENTED' });

  for (const result of [
    await adapter.claim(ref, 'agent-a'),
    await adapter.heartbeat(ref, 'agent-a'),
    await adapter.release(ref, {}, 'agent-a'),
    await adapter.requestProofOfLife(ref, 'agent-a'),
    await adapter.publishLiveness(ref, 'agent-a', { alive: true }),
    await adapter.readProofOfLife(ref)
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_CAP_UNSUPPORTED');
  }

  assert.equal(adapter.redact(null), '');
});

test('reference HTTP messenger runs through runtime ingress, reply, claim, status, review and log events', /** Verify reference HTTP messenger runs through runtime ingress, reply, claim, status, review and log events. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({
    externalId: 'issue-1',
    title: 'Ship the reference messenger',
    body: 'Exercise the real HTTP medium',
    kind: 'task',
    cwd: ctx.home,
    ext: { priority: 'high' }
  });

  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo
    .use(httpMessengerPlugin({
      baseUrl: medium.baseUrl,
      agent: 'agent-a',
      claimTtlMs: 1_000,
      heartbeatMs: 20,
      settleMs: 0
    }))
    .use(/** Implement worker. */ function worker(sumo) {
      sumo.on('work', /** Run the callback. */ async (work) => {
        assert.equal(work.title, 'Ship the reference messenger');
        assert.equal(work.can.reply, true);
        assert.equal(work.can.claim, true);
        assert.equal(work.can.react, true);
        assert.equal(work.ext.priority, 'high');

        const claim = await work.claim();
        assert.equal(claim.ok, true);
        const reply = await work.reply('done with ghp_abcdefghijklmnopqrstuvwxyz123456');
        assert.equal(reply.ok, true);
        const status = await work.status({ state: 'running', text: 'Working' });
        assert.equal(status.ok, true);
        const review = await work.review({ verdict: 'pass', text: 'Looks good' });
        assert.equal(review.ok, true);
        const reaction = await work.react('eyes');
        assert.equal(reaction.ok, true);
        const beat = await work.heartbeat();
        assert.equal(beat.ok, true);
        const released = await work.release({ state: 'done' });
        assert.equal(released.ok, true);
      });
    });

  await rt.start();
  try {
    await waitUntil(/** Run the callback. */ () => medium.getWork('issue-1')?.claims.some(/** Test whether an item matches. */ (m) => m.type === 'release' && m.agent === 'agent-a'), { timeoutMs: 15_000 });
    const stored = medium.getWork('issue-1');
    assert.equal(stored.replies[0].text, 'done with [redacted]', 'reply text is redacted before egress');
    assert.deepEqual(stored.statuses[0], { state: 'running', text: 'Working', ts: stored.statuses[0].ts });
    assert.deepEqual(stored.reviews[0], { verdict: 'pass', text: 'Looks good', ts: stored.reviews[0].ts });
    assert.deepEqual(stored.reactions[0], { emoji: 'eyes', ts: stored.reactions[0].ts });
    assert.ok(stored.claims.some(/** Test whether an item matches. */ (m) => m.type === 'claim' && m.agent === 'agent-a'));
    assert.ok(stored.claims.some(/** Test whether an item matches. */ (m) => m.type === 'release' && m.agent === 'agent-a'));

    let events = [];
    await waitUntil(/** Run the callback. */ async () => {
      events = [];
      for await (const [, event] of ctx.db.scan('evt:')) events.push(event);
      return events.some(/** Test whether an item matches. */ (e) => e.type === 'work.released' && e.payload.outcome.state === 'done');
    }, 15_000);
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.appeared' && e.source === 'messenger' && e.adapter === 'http-reference'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.claimed' && e.payload.agent === 'agent-a'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.status' && e.payload.status.state === 'running'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.review-posted' && e.payload.verdict === 'pass'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.heartbeat'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'work.released' && e.payload.outcome.state === 'done'));
  } finally {
    await rt.stop();
    await medium.close();
  }
});

test('reference HTTP messenger proof-of-life uses real HTTP routes and emits messenger events', /** Verify reference HTTP messenger proof-of-life uses real HTTP routes and emits messenger events. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'issue-2', title: 'Distributed liveness' });
  const adapter = new HttpMessenger({
    config: { baseUrl: medium.baseUrl, agent: 'agent-b', settleMs: 0 },
    db: ctx.db
  });
  const ref = { id: 'work_http_issue_2', externalId: 'issue-2', ext: {} };

  try {
    assert.deepEqual(await adapter.requestProofOfLife(ref, 'agent-z'), { ok: true });
    assert.deepEqual(await adapter.publishLiveness(ref, 'agent-z', { alive: true, status: 'ok' }), { ok: true });
    const pulses = await adapter.readProofOfLife(ref);
    assert.equal(pulses.ok, true);
    assert.deepEqual(pulses.value.map(/** Map one item. */ (p) => p.kind), ['request', 'alive']);

    const events = [];
    for await (const [, event] of ctx.db.scan('evt:')) events.push(event);
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'messenger.proof-of-life-request' && e.payload.agent === 'agent-z'));
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'messenger.proof-of-life-response' && e.payload.alive === true));
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger server supports real alternate HTTP routes', /** Verify reference HTTP messenger server supports real alternate HTTP routes. */ async () => {
  const medium = await createHttpMessengerServer();
  const url = /** Implement url. */ (pathname) => new URL(pathname, medium.baseUrl);
  const json = /** Implement json. */ async (pathname, init = {}) => {
    const res = await fetch(url(pathname), init);
    return { res, body: await res.json() };
  };

  try {
    assert.deepEqual((await json('/work')).body, { items: [] });

    const invalid = await json('/work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(invalid.res.status, 400);
    assert.equal(invalid.body.reason, 'externalId is required');

    const malformed = await fetch(url('/work'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(malformed.status, 500);
    assert.match((await malformed.json()).reason, /JSON/);

    assert.equal((await medium.postWork({ externalId: 'route-1', title: 'First' })).title, 'First');
    assert.equal((await medium.postWork({ externalId: 'route-1', title: 'Updated', body: 'Body' })).title, 'Updated');
    assert.equal(medium.getWork('route-1').body, 'Body');

    assert.equal((await json('/nowhere')).res.status, 404);
    assert.equal((await json('/work/missing/replies')).body.reason, 'unknown work missing');
    assert.deepEqual((await json('/work/route-1/replies')).body, { items: [] });
    assert.deepEqual((await json('/work/route-1/claim')).body, {});

    const touchWithoutClaim = await json('/work/route-1/touches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'agent-a' })
    });
    assert.deepEqual(touchWithoutClaim.body, { ok: true });

    await json('/work/route-1/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'agent-a' })
    });
    await json('/work/route-1/touches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'agent-a' })
    });
    await json('/work/route-1/releases', { method: 'POST' });
    assert.equal((await json('/work/route-1/claim')).body.claim, undefined);

    await json('/work/route-1/pulses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'request' })
    });
    assert.equal((await json('/work/route-1/pulses')).body.items[0].kind, 'request');
    assert.equal((await json('/work/route-1/unknown')).res.status, 404);
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger claim conflicts use the base lifecycle outcomes', /** Verify reference HTTP messenger claim conflicts use the base lifecycle outcomes. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'issue-3', title: 'Claim conflict' });
  const ref = { id: 'work_http_issue_3', externalId: 'issue-3', ext: {} };

  try {
    await fetch(new URL('/work/issue-3/claims', medium.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'agent-other' })
    });

    const held = await new HttpMessenger({
      config: { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, settleMs: 0 },
      db: ctx.db
    }).claim(ref, 'agent-a');
    assert.equal(held.ok, false);
    assert.equal(held.code, 'SUMO_CLAIM_HELD');
    assert.equal(held.heldBy, 'agent-other');

    const release = await new HttpMessenger({
      config: { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, settleMs: 0 },
      db: ctx.db
    }).release(ref, { state: 'done' }, 'agent-a');
    assert.equal(release.ok, true);
    assert.equal(medium.getWork('issue-3').claims.some(/** Test whether an item matches. */ (m) => m.type === 'release'), false);
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger reports a lost claim when the medium changes before settle completes', /** Verify reference HTTP messenger reports a lost claim when the medium changes before settle completes. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'issue-4', title: 'Claim race' });
  const ref = { id: 'work_http_issue_4', externalId: 'issue-4', ext: {} };
  const adapter = new HttpMessenger({
    config: { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, settleMs: 250, heartbeatMs: 1_000 },
    db: ctx.db
  });

  try {
    const claim = adapter.claim(ref, 'agent-a');
    const steal = (/** Run the callback. */ async () => {
      await waitUntil(/** Run the callback. */ () => medium.getWork('issue-4')?.claims.some(/** Test whether an item matches. */ (m) => m.type === 'claim' && m.agent === 'agent-a'));
      const res = await fetch(new URL('/work/issue-4/claims', medium.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'agent-b' })
      });
      assert.equal(res.ok, true);
    })();

    const result = await claim;
    await steal;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_CLAIM_LOST');
    assert.equal(result.heldBy, 'agent-b');
  } finally {
    adapter.stopHeartbeat(ref.id);
    await medium.close();
  }
});

test('reference HTTP messenger maps real medium outages to operational Results', /** Verify reference HTTP messenger maps real medium outages to operational Results. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'issue-5', title: 'Outage' });
  const baseUrl = medium.baseUrl;
  await medium.close();

  const adapter = new HttpMessenger({
    config: { baseUrl, agent: 'agent-a', claimTtlMs: 10_000, settleMs: 0 },
    db: ctx.db
  });
  const ref = { id: 'work_http_issue_5', externalId: 'issue-5', ext: {} };

  for (const result of [
    await adapter.say(ref, 'reply'),
    await adapter.status(ref, { state: 'running' }),
    await adapter.review(ref, { verdict: 'pass' }),
    await adapter.react(ref, 'eyes'),
    await adapter.claim(ref, 'agent-a'),
    await adapter.heartbeat(ref, 'agent-a'),
    await adapter.release(ref, {}, 'agent-a'),
    await adapter.requestProofOfLife(ref, 'agent-b'),
    await adapter.publishLiveness(ref, 'agent-b', { alive: false, status: 'stale' }),
    await adapter.readProofOfLife(ref)
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_MEDIUM_ERROR');
  }
});

test('reference HTTP messenger maps unknown medium work to operational Results', /** Verify reference HTTP messenger maps unknown medium work to operational Results. */ async () => {
  const medium = await createHttpMessengerServer();
  const adapter = new HttpMessenger({
    config: { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, settleMs: 0 },
    db: ctx.db
  });
  const ref = { id: 'work_http_missing', externalId: 'missing-work', ext: {} };

  try {
    for (const result of [
      await adapter.claim(ref, 'agent-a'),
      await adapter.heartbeat(ref, 'agent-a'),
      await adapter.release(ref, {}, 'agent-a'),
      await adapter.requestProofOfLife(ref, 'agent-b'),
      await adapter.publishLiveness(ref, 'agent-b', { alive: false, status: 'stale' }),
      await adapter.readProofOfLife(ref)
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SUMO_MEDIUM_ERROR');
      assert.match(result.reason, /unknown work missing-work/);
    }
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger drives base store, mirror, lifecycle and failure branches through public paths', /** Verify reference HTTP messenger drives base store, mirror, lifecycle and failure branches through public paths. */ async () => {
  const medium = await createHttpMessengerServer();
  const branchStore = storage(ctx.db, 'messenger:http-reference', 'base-branches');
    const agentConfig = { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, heartbeatMs: 1_000, settleMs: 0 };

  try {
    await medium.postWork({ externalId: 'branch-seen', title: 'Seen branch' });
    const seenAdapter = new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore });
    const first = await collectIngress(seenAdapter);
    assert.equal(first.length, 1);
    assert.equal((await first[0].react('eyes')).ok, true);
    assert.deepEqual(medium.getWork('branch-seen').reactions[0], { emoji: 'eyes', ts: medium.getWork('branch-seen').reactions[0].ts });

    const second = await collectIngress(new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore }));
    assert.equal(second.length, 0, 'seen store suppresses re-ingest through the real base path');

    const noDbAdapter = new HttpMessenger({ config: agentConfig, store: storage(ctx.db, 'messenger:http-reference', 'no-db') });
    assert.equal((await collectIngress(noDbAdapter)).length, 1, 'without a daemon append, the item is delivered live');
    assert.equal((await collectIngress(noDbAdapter)).length, 1, 'without a daemon append, the seen marker is not written');

    await medium.postWork({ externalId: 'branch-mirror-fresh', title: 'Fresh mirror' });
    const freshRef = { id: 'work_branch_mirror_fresh', externalId: 'branch-mirror-fresh', ext: {} };
    await branchStore.set(`claim:${freshRef.id}`, { agent: 'agent-other', ts: Date.now() });
    const held = await new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore }).claim(freshRef, 'agent-a');
    assert.equal(held.ok, false);
    assert.equal(held.code, 'SUMO_CLAIM_HELD');
    assert.equal(held.heldBy, 'agent-other');
    assert.equal(medium.getWork('branch-mirror-fresh').claims.length, 0, 'fresh mirror denies before touching the medium');

    await medium.postWork({ externalId: 'branch-mirror-stale', title: 'Stale mirror' });
    const staleRef = { id: 'work_branch_mirror_stale', externalId: 'branch-mirror-stale', ext: {} };
    await branchStore.set(`claim:${staleRef.id}`, { agent: 'agent-other', ts: Date.now() - 60_000 });
    const ac = new AbortController();
    const staleClaim = await new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore, signal: ac.signal }).claim(staleRef, 'agent-a');
    assert.equal(staleClaim.ok, true);
    ac.abort();

    await medium.postWork({ externalId: 'branch-mirror-nonfinite', title: 'Non-finite mirror' });
    const nonFiniteRef = { id: 'work_branch_mirror_nonfinite', externalId: 'branch-mirror-nonfinite', ext: {} };
    await branchStore.set(`claim:${nonFiniteRef.id}`, { agent: 'agent-other', ts: 'not-a-number' });
    const nonFiniteClaim = await new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore }).claim(nonFiniteRef, 'agent-a');
    assert.equal(nonFiniteClaim.ok, true);

    await medium.postWork({ externalId: 'branch-lost-release', title: 'Lost to release' });
    const lostRef = { id: 'work_branch_lost_release', externalId: 'branch-lost-release', ext: {} };
    const lostAdapter = new HttpMessenger({ config: { ...agentConfig, settleMs: 250 }, db: ctx.db, store: branchStore });
    const lostClaim = lostAdapter.claim(lostRef, 'agent-a');
    const release = (/** Run the callback. */ async () => {
      await waitUntil(/** Run the callback. */ () => medium.getWork('branch-lost-release')?.claims.some(/** Test whether an item matches. */ (m) => m.type === 'claim' && m.agent === 'agent-a'));
      const res = await fetch(new URL('/work/branch-lost-release/releases', medium.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'agent-a' })
      });
      assert.equal(res.ok, true);
    })();
    const lost = await lostClaim;
    await release;
    assert.equal(lost.ok, false);
    assert.equal(lost.code, 'SUMO_CLAIM_LOST');
    assert.equal(lost.heldBy, undefined);

    const evicted = await new HttpMessenger({ config: agentConfig, db: ctx.db }).publishLiveness(staleRef, 'agent-a', { alive: false, status: 'dead' });
    assert.equal(evicted.ok, true);
    assert.equal(medium.getWork('branch-mirror-stale').pulses.at(-1).kind, 'evict');

    const released = await new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore }).release(staleRef);
    assert.equal(released.ok, true);

    await medium.postWork({ externalId: 'branch-unclaimed-release', title: 'Unclaimed release' });
    const unclaimedRef = { id: 'work_branch_unclaimed_release', externalId: 'branch-unclaimed-release', ext: {} };
    const unclaimedRelease = await new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore }).release(unclaimedRef, { state: 'noop' });
    assert.equal(unclaimedRelease.ok, true);
    assert.equal(medium.getWork('branch-unclaimed-release').claims.at(-1).type, 'release');
  } finally {
    await medium.close();
  }

  const outage = await createHttpMessengerServer();
  try {
    await outage.postWork({ externalId: 'branch-outage-bound', title: 'Bound failures' });
    const [work] = await collectIngress(new HttpMessenger({ config: { baseUrl: outage.baseUrl, agent: 'agent-a', settleMs: 0 } }));
    await outage.close();

    for (const result of [
      await work.reply('reply'),
      await work.status({ state: 'blocked' }),
      await work.review({ verdict: 'fail' }),
      await work.react('confused')
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SUMO_MEDIUM_ERROR');
    }
  } finally {
    await outage.close().catch(/** Handle the expected rejection. */ () => {});
  }
});

test('reference HTTP messenger normalizes empty reply and release payloads and falls back from a non-finite claim timestamp', /** Verify reference HTTP messenger uses public paths for empty replies, empty releases, and non-finite claim timestamps. */ async () => {
  const medium = await createHttpMessengerServer();
  const branchStore = storage(ctx.db, 'messenger:http-reference', 'normalization-branches');
  const agentConfig = { baseUrl: medium.baseUrl, agent: 'agent-a', claimTtlMs: 10_000, heartbeatMs: 1_000, settleMs: 50 };

  try {
    await medium.postWork({ externalId: 'branch-empty-reply', title: 'Empty reply' });
    const [replyWork] = await collectIngress(new HttpMessenger({ config: agentConfig, db: ctx.db }));
    assert.equal((await replyWork.reply(undefined)).ok, true);
    assert.equal(medium.getWork('branch-empty-reply').replies.at(-1).text, '');

    await medium.postWork({ externalId: 'branch-empty-release', title: 'Empty release' });
    const releaseRef = { id: 'work_branch_empty_release', externalId: 'branch-empty-release', ext: {} };
    const releaseAdapter = new HttpMessenger({ config: agentConfig, db: ctx.db });
    assert.equal((await releaseAdapter.claim(releaseRef, 'agent-a')).ok, true);
    assert.equal((await releaseAdapter.release(releaseRef)).ok, true);
    assert.equal(medium.getWork('branch-empty-release').claims.at(-1).type, 'release');

    await medium.postWork({ externalId: 'branch-nonfinite-ts', title: 'Non-finite claim timestamp' });
    const ref = { id: 'work_branch_nonfinite_ts', externalId: 'branch-nonfinite-ts', ext: {} };
    const adapter = new HttpMessenger({ config: agentConfig, db: ctx.db, store: branchStore });
    const claim = adapter.claim(ref, 'agent-a');
    await waitUntil(() => medium.getWork('branch-nonfinite-ts')?.claims.some((marker) => marker.type === 'claim' && marker.agent === 'agent-a'));
    medium.getWork('branch-nonfinite-ts').claims.at(-1).ts = Number.NaN;
    const claimed = await claim;
    assert.equal(claimed.ok, true);
    const mirrored = await branchStore.get(`claim:${ref.id}`);
    assert.equal(mirrored.agent, 'agent-a');
    assert.equal(Number.isFinite(mirrored.ts), true);
    adapter.stopHeartbeat(ref.id);
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger supports honest capability degradation for a read-only adapter variant', /** Verify reference HTTP messenger supports honest capability degradation for a read-only adapter variant. */ async () => {
  const medium = await createHttpMessengerServer();
  await medium.postWork({ externalId: 'read-only-1', title: 'Read-only work', body: '', kind: 'task' });
  try {
    const [work] = await collectIngress(new ReadOnlyHttpMessenger({ config: { baseUrl: medium.baseUrl }, db: ctx.db }));
    assert.equal(work.can.reply, false);
    assert.equal(work.can.claim, false);
    assert.equal(work.can.status, false);
    assert.equal(work.can.review, false);

    for (const result of [
      await work.reply('reply'),
      await work.claim(),
      await work.heartbeat(),
      await work.release(),
      await work.status({ state: 'running' }),
      await work.review({ verdict: 'pass' }),
      await work.react('eyes')
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SUMO_CAP_UNSUPPORTED');
    }

    assert.equal((await new ReadOnlyHttpMessenger({ config: { baseUrl: medium.baseUrl } }).readProofOfLife({ id: 'work_read_only_1', externalId: 'read-only-1', ext: {} })).code, 'SUMO_CAP_UNSUPPORTED');
  } finally {
    await medium.close();
  }
});

test('reference HTTP messenger polling loop exits on the real abort signal', /** Verify reference HTTP messenger polling loop exits on the real abort signal. */ async () => {
  const medium = await createHttpMessengerServer();
  const controller = new AbortController();
  const adapter = new HttpMessenger({
    config: { baseUrl: medium.baseUrl, pollMs: 10 },
    signal: controller.signal
  });

  const done = collectIngress(adapter);
  setTimeout(/** Run the timer callback. */ () => controller.abort(), 20);
  try {
    assert.deepEqual(await done, []);
  } finally {
    await medium.close();
  }
});
