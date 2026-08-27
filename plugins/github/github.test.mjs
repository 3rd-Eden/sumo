import { test } from 'node:test';
import assert from 'node:assert/strict';

import githubPlugin from './index.mjs';
import { GitHubConfig, GitHubMessenger } from './github.mjs';

const REPO = 'sumo-reference-tests/does-not-exist';
const ref = {
  id: 'work_github_boundary',
  externalId: `${REPO}#1`,
  title: 'Boundary failure coverage',
  body: '',
  ext: { number: 1, repo: REPO }
};

test('github config applies production defaults and rejects malformed repo identifiers', /** Verify github config applies production defaults and rejects malformed repo identifiers. */ () => {
  const cfg = GitHubConfig.parse({ repo: 'owner/name' });

  assert.deepEqual(cfg, {
    repo: 'owner/name',
    label: 'sumo:ready',
    claimLabel: 'sumo:claimed',
    claimTtlMs: 300_000,
    heartbeatMs: 60_000,
    settleMs: 1_000,
    trust: 'write'
  });
  assert.throws(
    /** Run the callback. */ () => GitHubConfig.parse({ repo: 'owner' }),
    /** Run the callback. */ (error) => error?.issues?.[0]?.message === 'repo must be "owner/name"'
  );
});

test('github plugin registers the real messenger factory with validated options', /** Verify github plugin registers the real messenger factory with validated options. */ () => {
  const calls = [];
  const options = GitHubConfig.parse({ repo: REPO, trust: 'all', agent: 'agent_github_test' });

  githubPlugin({ messenger: /** Implement messenger. */ (id, factory) => calls.push({ id, factory }) }, options);

  assert.equal(githubPlugin.sumo.name, 'github');
  assert.equal(githubPlugin.sumo.config, GitHubConfig);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'github');

  const adapter = calls[0].factory({});
  assert.equal(adapter.id, 'github');
  assert.deepEqual(adapter.can, {
    reply: true,
    claim: true,
    status: true,
    review: true,
    react: false,
    distributed: true
  });
  assert.equal(adapter.ctx.config.repo, REPO);
});

test('github messenger write APIs surface real gh boundary failures as Results', /** Verify github messenger write APIs surface real gh boundary failures as Results. */ async () => {
  const adapter = new GitHubMessenger({
    config: GitHubConfig.parse({ repo: REPO, trust: 'all', agent: 'agent_github_test', settleMs: 1 })
  });

  for (const result of [
    await adapter.say(ref, 'plain reply'),
    await adapter.status(ref, { state: 'running', text: 'working with ghp_123456789012345678901234' }),
    await adapter.review(ref, { verdict: 'changes_requested', text: 'needs changes' }),
    await adapter.requestProofOfLife(ref, 'agent_other'),
    await adapter.publishLiveness(ref, { agent: 'agent_github_test', verdict: 'alive' })
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_MEDIUM_ERROR');
    assert.match(result.reason, /github:|proof-of-life/);
  }
});

test('github messenger ingress uses the real gh boundary when listing work', /** Verify github messenger ingress uses the real gh boundary when listing work. */ async () => {
  const adapter = new GitHubMessenger({ config: GitHubConfig.parse({ repo: REPO, trust: 'all' }) });

  await assert.rejects(/** Run the callback. */ async () => {
    for await (const _work of adapter.work()) {
      assert.fail('the invalid repository should not yield work');
    }
  }, /Command failed|spawn gh|Could not resolve|not found|HTTP 404/);
});

test('github messenger medium primitives use the real gh boundary for claim and pulse reads', /** Verify github messenger medium primitives use the real gh boundary for claim and pulse reads. */ async () => {
  const adapter = new GitHubMessenger({
    config: GitHubConfig.parse({ repo: REPO, trust: 'all', agent: 'agent_github_test', settleMs: 1 })
  });

  for (const op of [
    /** Run the callback. */ () => adapter.mark(ref),
    /** Run the callback. */ () => adapter.mark(ref, 'agent_github_test'),
    /** Run the callback. */ () => adapter.mark(ref, null),
    /** Run the callback. */ () => adapter.touch(ref, 'agent_github_test'),
    /** Run the callback. */ () => adapter.pulses(ref),
    /** Run the callback. */ () => adapter.pulse(ref, 'alive', { agent: 'agent_github_test' })
  ]) {
    await assert.rejects(op, /Command failed|spawn gh|Could not resolve|not found|HTTP 404/);
  }
});

test('github messenger heartbeat maps real gh boundary failure through the base Result path', /** Verify github messenger heartbeat maps real gh boundary failure through the base Result path. */ async () => {
  const adapter = new GitHubMessenger({
    config: GitHubConfig.parse({ repo: REPO, trust: 'all', agent: 'agent_github_test', settleMs: 1 })
  });

  const result = await adapter.heartbeat(ref, 'agent_github_test');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUMO_MEDIUM_ERROR');
  assert.match(result.reason, /github: heartbeat failed/);
});
