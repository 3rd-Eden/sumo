/**
 * Messenger conformance — ALL REAL (CONVENTIONS §5: no mocks, no fakes, no test-only adapter). The
 * `sumo/messenger` base is exercised through the real `GitHubMessenger` against the repository named
 * by `SUMO_GITHUB_TEST_REPO`, with a real daemon db and the real plugin
 * `mctx` (real `storage`/`providers`). GitHub is the only messenger that exists, so the base's
 * medium-agnostic lifecycle is proven through it; a future *real* second adapter plugs into the same
 * `CAN` matrix. Determinism comes from controlling the order of real operations, never a stand-in.
 *
 * Requires `gh` CLI auth + write access to the configured repo. If either is missing, live medium
 * tests skip with a clear reason; they never mock the medium.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolve } from 'sumo/config';
import { open } from 'sumo/db';
import { storage, providers } from 'sumo/plugin';
import { GitHubMessenger, GitHubConfig } from './github.mjs';
import { mark } from './_marker.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

/** Adapter classes under conformance (one entry now; a 2nd real adapter plugin slots in identically). */
const ADAPTERS = { github: GitHubMessenger };

/** The capability matrix each adapter's declared `can` must match. */
const CAN = {
  github: { reply: true, claim: true, status: true, review: true, react: false, distributed: true }
};

let db;
let home;
let cfg;
let repo;
let liveSkip = false;
/** @type {number[]} */
const created = [];

/**
 * Run the GitHub CLI with enough buffer for issue payloads.
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function gh(args) {
  return exec('gh', args, { maxBuffer: 16 * 1024 * 1024 });
}

const liveRepo = process.env.SUMO_GITHUB_TEST_REPO?.trim();
const resolved = resolve({ cwd: fixtures });
cfg = GitHubConfig.parse({ ...(resolved.config.plugins?.github ?? {}), repo: liveRepo || 'owner/repo' });
repo = cfg.repo;

if (!liveRepo) {
  liveSkip = 'messenger conformance requires SUMO_GITHUB_TEST_REPO=owner/repo';
} else {
  try {
    await gh(['auth', 'status']);
    await gh(['repo', 'view', repo]);
  } catch (e) {
    liveSkip = `messenger conformance requires gh auth and access to ${repo}: ${/** @type {Error} */ (e).message}`;
  }
}

before(/** Run the before hook. */ async () => {
  // Ensure the ready + claim labels exist (idempotent).
  if (!liveSkip) {
    await gh(['label', 'create', cfg.label, '--repo', repo, '--color', 'c2e0c6', '--force']).catch(/** Handle the expected rejection. */ () => {});
    await gh(['label', 'create', cfg.claimLabel, '--repo', repo, '--color', 'ededed', '--force']).catch(/** Handle the expected rejection. */ () => {});
    await gh(['label', 'create', 'discussion', '--repo', repo, '--color', 'bfdadc', '--force']).catch(/** Handle the expected rejection. */ () => {});
  }

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-msgr-'));
  db = await open({ home, idleShutdownMs: 1000, sweepIntervalMs: 300 });
});

after(/** Run the after hook. */ async () => {
  for (const n of created) await gh(['issue', 'close', String(n), '--repo', repo]).catch(/** Handle the expected rejection. */ () => {});
  if (db) await db.close();
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

/** Build a real adapter with the real plugin build-context (real store, real db, real builders). */
function makeAdapter(extra = {}) {
  const prov = providers({ db, /** Implement adapterStore. */ adapterStore(name) { return storage(db, name, 'main'); }, /** Implement configFor. */ configFor() { return ({}); } });
  prov.messenger('github', /** Run the callback. */ (mctx) => new GitHubMessenger({ ...mctx, config: { ...cfg, ...extra } }));
  return prov.instantiateMessengers()[0].adapter;
}

/**
 * Create a live GitHub issue and remember it for teardown.
 * @param {string} title
 * @returns {Promise<number>}
 */
async function createIssue(title, labels = []) {
  const { stdout } = await gh(['issue', 'create', '--repo', repo, '--title', title, '--body', 'conformance', '--label', cfg.label]);
  const n = Number(stdout.trim().match(/\/(\d+)\s*$/)[1]);
  created.push(n);
  for (const label of labels) await gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', label]);
  return n;
}

/** Drain ingress until the work for `number` appears (retrying briefly: `gh issue list` is fresh, but
 *  the just-created issue may take a beat to surface). */
async function workFor(adapter, number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    for await (const w of adapter.ingress()) if (w.ext.number === number) return w;
    await new Promise(/** Run the callback. */ (r) => setTimeout(r, 500));
  }
  return undefined;
}

/** A claim/lifecycle ref for a known issue — the adapter primitives key off `ext.number`; `id` only
 *  keys the local mirror + event payloads, so a stable per-issue id suffices (no ingress needed). */
function refFor(number) {
  return { id: `work_e2e_${number}`, ext: { number, repo } };
}

/**
 * Read daemon events of a specific type.
 * @param {string} type
 * @returns {Promise<object[]>}
 */
async function eventsOfType(type) {
  const out = [];
  for await (const [, v] of db.scan('evt:')) if (v && v.type === type) out.push(v);
  return out;
}

/**
 * Read label names on a live GitHub issue.
 * @param {number} n
 * @returns {Promise<string[]>}
 */
async function issueLabels(n) {
  const { stdout } = await gh(['issue', 'view', String(n), '--repo', repo, '--json', 'labels']);
  return JSON.parse(stdout).labels.map(/** Map one item. */ (l) => l.name);
}

// ── declared can matches behavior (parametrized; no network) ──────────────────────────────────────

for (const id of Object.keys(CAN)) {
  test(`${id}: declared can matches the capability matrix`, /** Run the callback. */ () => {
    const a = new ADAPTERS[id]({ config: { repo: 'owner/name' } });
    assert.deepEqual(a.can, CAN[id]);
  });
}

// ── ingress + work shape (real GitHub) ────────────────────────────────────────────────────────────

test('github: *work() yields a valid bound work item, emits work.appeared, and degrades react', { skip: liveSkip }, /** Verify github: *work() yields a valid bound work item, emits work.appeared, and degrades react. */ async () => {
  const n = await createIssue('ingress probe');
  const adapter = makeAdapter();
  const work = await workFor(adapter, n);
  assert.ok(work, 'ingress yielded the created issue');
  assert.match(work.id, /^work_[0-9a-f]{32}$/);
  assert.equal(work.ext.repo, repo);
  assert.equal(work.can.claim, true);
  assert.equal(work.can.react, false);

  const appeared = await eventsOfType('work.appeared');
  assert.ok(appeared.some(/** Test whether an item matches. */ (e) => e.payload.workRef === work.id), 'work.appeared landed on the one log');
  assert.ok(appeared.every(/** Test whether every item matches. */ (e) => e.source === 'messenger' && e.adapter === 'github'));

  // An unsupported optional (react, can.react=false) degrades — never fakes, never throws.
  const r = await work.react('rocket');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CAP_UNSUPPORTED');
});

test('github: discussion-labeled issues ingress as planning work', { skip: liveSkip }, /** Verify github: discussion-labeled issues ingress as planning work. */ async () => {
  const n = await createIssue('discussion planning probe', ['discussion']);
  const adapter = makeAdapter();
  const work = await workFor(adapter, n);

  assert.ok(work, 'ingress yielded the created discussion issue');
  assert.equal(work.ext.kind, 'planning');
});

// ── claim lifecycle (real GitHub + real mirror) ─────────────────────────────────────────────────

test('github: claim posts label+marker, a second agent sees it HELD, release clears it', { skip: liveSkip }, /** Verify github: claim posts label+marker, a second agent sees it HELD, release clears it. */ async () => {
  const n = await createIssue('claim probe');
  const adapter = makeAdapter({ claimTtlMs: 300_000 }); // long TTL: the claim must stay fresh across the intervening gh calls
  const work = refFor(n);

  assert.equal((await adapter.touch(work, 'agent-a')).ok, true, 'touch before a claim is a real no-op');
  assert.equal((await adapter.mark(work, null)).ok, true, 'clearing an unclaimed issue posts a release marker');
  assert.equal(await adapter.mark(work), undefined, 'an agentless release marker leaves no active claim');

  const a = await adapter.claim(work, 'agent-a');
  assert.equal(a.ok, true, `claim should succeed: ${JSON.stringify(a)}`);
  adapter.stopHeartbeat(work.id);
  assert.ok((await issueLabels(n)).includes(cfg.claimLabel), 'claim label applied');
  assert.ok((await eventsOfType('work.claimed')).some(/** Test whether an item matches. */ (e) => e.payload.agent === 'agent-a'), 'work.claimed emitted');

  // Pre-check path: a different agent sees the fresh claim and is told who holds it — no second marker.
  const b = await adapter.claim(work, 'agent-b');
  assert.equal(b.ok, false);
  assert.equal(b.code, 'SUMO_CLAIM_HELD');
  assert.equal(b.heldBy, 'agent-a');

  // A non-holder's release is a no-op — it must not clear agent-a's claim (agent-aware release).
  const steal = await adapter.release(work, {}, 'agent-b');
  assert.equal(steal.ok, true);
  assert.ok((await issueLabels(n)).includes(cfg.claimLabel), 'a non-holder release did not clear the claim');
  assert.equal((await adapter.touch(work, 'agent-b')).ok, true, 'touch by a non-holder is a real no-op');

  const rel = await adapter.release(work, { outcome: 'done' }, 'agent-a'); // agent-aware: the holder releases
  assert.equal(rel.ok, true);
  assert.ok(!(await issueLabels(n)).includes(cfg.claimLabel), 'claim label removed on release');
  assert.equal(await adapter.mark(work), undefined, 'no active claim after release');
});

test('github: an expired claim is reclaimable (reclaim-on-expiry)', { skip: liveSkip }, /** Verify github: an expired claim is reclaimable (reclaim-on-expiry). */ async () => {
  const n = await createIssue('reclaim probe');
  const adapter = makeAdapter(); // fixture TTL is 4s
  const work = refFor(n);

  const a = await adapter.claim(work, 'agent-a');
  assert.equal(a.ok, true);
  adapter.stopHeartbeat(work.id); // freeze liveness so the claim genuinely ages out

  await new Promise(/** Run the callback. */ (r) => setTimeout(r, cfg.claimTtlMs + 1500));

  const b = await adapter.claim(work, 'agent-b');
  assert.equal(b.ok, true, `stale claim should be reclaimable: ${JSON.stringify(b)}`);
  adapter.stopHeartbeat(work.id);
  const holder = await adapter.mark(work);
  assert.equal(holder.agent, 'agent-b', 'agent-b is now the active claimant');
});

test('github: two concurrent claimers — exactly one wins, the loser sees heldBy (last-claim-wins)', { skip: liveSkip }, /** Verify github: two concurrent claimers — exactly one wins, the loser sees heldBy (last-claim-wins). */ async () => {
  const n = await createIssue('race probe');
  const adapter = makeAdapter();
  const work = refFor(n);

  const [ra, rb] = await Promise.all([adapter.claim(work, 'agent-a'), adapter.claim(work, 'agent-b')]);
  adapter.stopHeartbeat(work.id);
  const winners = [ra, rb].filter(/** Select matching items. */ (r) => r.ok);
  const losers = [ra, rb].filter(/** Select matching items. */ (r) => !r.ok);
  assert.equal(winners.length, 1, `exactly one winner (got ${JSON.stringify([ra, rb])})`);
  assert.equal(losers.length, 1);

  // The medium is the arbiter: a fresh read agrees with the winner.
  const holder = await adapter.mark(work);
  const winnerAgent = ra.ok ? 'agent-a' : 'agent-b';
  assert.equal(holder.agent, winnerAgent, 'the medium’s last active claim is the winner');
  assert.equal(losers[0].heldBy, winnerAgent, 'the loser is told who holds it');
});

test('github: a fresh sibling claim in the local mirror short-circuits to HELD (fast negative pre-check)', { skip: liveSkip }, /** Verify github: a fresh sibling claim in the local mirror short-circuits to HELD (fast negative pre-check). */ async () => {
  const n = await createIssue('mirror pre-check probe');
  const adapter = makeAdapter({ claimTtlMs: 300_000 });
  const work = refFor(n);

  // Seed the SAME daemon-store mirror a sibling instance on this machine would write.
  const store = storage(db, 'messenger:github', 'main');
  await store.set(`claim:${work.id}`, { agent: 'sibling', ts: Date.now() }, { ttlMs: 300_000 });

  const r = await adapter.claim(work, 'me');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_CLAIM_HELD');
  assert.equal(r.heldBy, 'sibling');
  // Proof it short-circuited before the medium: no claim label was applied to the issue.
  assert.ok(!(await issueLabels(n)).includes(cfg.claimLabel), 'no medium claim was posted');
});

test('github: markers from authors outside the allowlist are ignored (trust filter)', { skip: liveSkip }, /** Verify github: markers from authors outside the allowlist are ignored (trust filter). */ async () => {
  const n = await createIssue('allowlist probe');
  const adapter = makeAdapter({ authors: ['nobody-allowed'], claimTtlMs: 300_000 });
  const work = refFor(n);
  // The authed account is not in the allowlist, so even our own claim marker is not honored.
  const r = await adapter.claim(work, 'agent-a');
  adapter.stopHeartbeat(work.id);
  assert.equal(r.ok, false, 'claim not honored when the marker author is outside the allowlist');
  assert.equal(await adapter.mark(work), undefined, 'no trusted claim is visible');
});

test('github: release markers from the wrong agent do not clear a claim, but agentless restart markers do', { skip: liveSkip }, /** Verify github: release markers from the wrong agent do not clear a claim, but agentless restart markers do. */ async () => {
  const n = await createIssue('restart probe');
  const adapter = makeAdapter({ trust: 'all', claimTtlMs: 300_000 });
  const work = refFor(n);

  const claimed = await adapter.claim(work, 'agent-a');
  assert.equal(claimed.ok, true);
  adapter.stopHeartbeat(work.id);

  await gh(['issue', 'comment', String(n), '--repo', repo, '--body', `${mark('release', { agent: 'agent-b' })}\nwrong releaser`]);
  const afterWrongRelease = await adapter.mark(work);
  assert.equal(afterWrongRelease?.agent, 'agent-a', 'another agent cannot clear the active claim');

  await gh(['issue', 'comment', String(n), '--repo', repo, '--body', `${mark('restart', {})}\nreset state`]);
  assert.equal(await adapter.mark(work), undefined, 'an agentless restart marker clears the active claim');
});

test('github: heartbeat bumps the claim comment without adding a new comment', { skip: liveSkip }, /** Verify github: heartbeat bumps the claim comment without adding a new comment. */ async () => {
  const n = await createIssue('heartbeat probe');
  const adapter = makeAdapter();
  const work = refFor(n);
  await adapter.claim(work, 'agent-a');
  adapter.stopHeartbeat(work.id);

  const commentsBefore = (await adapter.mark(work)).ext.commentId;
  const before = await adapter.mark(work);
  await new Promise(/** Run the callback. */ (r) => setTimeout(r, 1100));
  await adapter.heartbeat(work, 'agent-a');
  const afterState = await adapter.mark(work);

  assert.equal(afterState.agent, 'agent-a');
  assert.equal(afterState.ext.commentId, commentsBefore, 'same claim comment edited (no new comment)');
  assert.ok(afterState.ts >= before.ts, 'claim server timestamp advanced');
});

// ── proof-of-life medium primitives (real GitHub; gated can.distributed) ────────────────────────

test('github: proof-of-life request/liveness post markers + emit messenger.* events', { skip: liveSkip }, /** Verify github: proof-of-life request/liveness post markers + emit messenger.* events. */ async () => {
  const n = await createIssue('proof-of-life probe');
  const adapter = makeAdapter({ trust: 'all' });
  const ref = refFor(n);

  assert.equal((await adapter.status(ref, 'booting')).ok, true);
  assert.equal((await adapter.review(ref, { verdict: 'pass' })).ok, true);
  assert.equal((await adapter.pulse(ref, 'alive')).ok, true, 'pulse accepts an empty real marker payload');
  assert.equal((await adapter.requestProofOfLife(ref, 'agent-a')).ok, true);
  assert.equal((await adapter.publishLiveness(ref, 'agent-a', { alive: true, status: 'healthy' })).ok, true);
  assert.equal((await adapter.publishLiveness(ref, 'agent-b', { alive: false, status: 'expired' })).ok, true);

  const seen = await adapter.readProofOfLife(ref);
  assert.equal(seen.ok, true);
  assert.ok(seen.value.some(/** Test whether an item matches. */ (m) => m.kind === 'proof-of-life' && m.agent === 'agent-a'), 'request marker present');
  assert.ok(seen.value.some(/** Test whether an item matches. */ (m) => m.kind === 'alive' && !m.agent), 'empty alive marker present');
  assert.ok(seen.value.some(/** Test whether an item matches. */ (m) => m.kind === 'alive' && m.agent === 'agent-a'), 'alive marker present');
  assert.ok(seen.value.some(/** Test whether an item matches. */ (m) => m.kind === 'evict' && m.agent === 'agent-b'), 'evict marker present');

  assert.ok((await eventsOfType('messenger.proof-of-life-request')).some(/** Test whether an item matches. */ (e) => e.payload.agent === 'agent-a'));
  assert.ok((await eventsOfType('messenger.proof-of-life-response')).some(/** Test whether an item matches. */ (e) => e.payload.alive === true));
  assert.ok((await eventsOfType('messenger.proof-of-life-response')).some(/** Test whether an item matches. */ (e) => e.payload.alive === false));
});

// ── mirror TTL in isolation (real daemon store, no medium) ──────────────────────────────────────

test('the claims mirror honors ttlMs against the real daemon store', /** Verify the claims mirror honors ttlMs against the real daemon store. */ async () => {
  const store = storage(db, 'messenger:github', 'main');
  await store.set('claim:work_ttltest', { agent: 'x' }, { ttlMs: 600 });
  assert.deepEqual(await store.get('claim:work_ttltest'), { agent: 'x' });
  await new Promise(/** Run the callback. */ (r) => setTimeout(r, 1800)); // ttl 600ms + sweep interval 300ms + margin
  assert.equal(await store.get('claim:work_ttltest'), undefined, 'mirror entry expired by ttlMs');
});
