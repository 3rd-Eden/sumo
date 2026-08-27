/**
 * The one parametrized conformance suite over all four adapters (CONVENTIONS §4). It runs against the
 * REAL committed transcript captures (reused from `sumo/transcript`) and this package's plan/config
 * fixtures (capture-first, §3f). Appends go through a real temp daemon and are validated against the
 * real `EventInput` contract; cross-source collapse, redaction, and correlation are covered further
 * in the sibling test files.
 *
 * Asserts: (1) `can` matrix, (2) capability gate (OpenCode tail → SUMO_CAP_UNSUPPORTED), (3) import
 * normalizes + appends + validates + tags source/adapter + emits transcript.ingested, (4) the parser
 * entry point each acquirer feeds, (5) per-harness correlation signals, (6) plan summarize.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { adapters, plan, parse, isResult, CAP_UNSUPPORTED, Artifacts } from '../src/index.mjs';
import { EventInput } from '../../db/src/schema.mjs';
import { allEvents, openTempDb, readTranscript } from './_daemon.mjs';

const CAN = {
  'claude-code': { tail: true, import: true },
  copilot: { tail: true, import: true },
  codex: { tail: true, import: true },
  cursor: { tail: true, import: true },
  opencode: { tail: false, import: true }
};

const ENTRY = { 'claude-code': 'file', copilot: 'file', codex: 'file', cursor: 'file', opencode: 'stream' };

/** The real on-disk capture each acquirer imports (OpenCode replays its SSE stream export). */
const IMPORT_FIXTURE = {
  'claude-code': 'claude-code/file/turn.jsonl',
  copilot: 'copilot/file/turn.jsonl',
  codex: 'codex/file/turn.jsonl',
  cursor: 'cursor/file/turn.jsonl',
  opencode: 'opencode/stream/turn.jsonl'
};

test('base Artifacts declares unsupported defaults and no transcript root', /** Verify base Artifacts declares unsupported defaults and no transcript root. */ async () => {
  const base = new Artifacts();
  assert.equal(base.transcriptRoot(), null);
  assert.deepEqual(base.signals(), {});
  assert.deepEqual(await base.import([], { db: { /** Implement append. */ append() { throw new Error('not reached'); } } }), {
    ok: false,
    code: CAP_UNSUPPORTED,
    reason: ': import unsupported'
  });
  assert.throws(/** Run the callback. */ () => base.entry, { code: 'SUMO_NO_PARSER' });
});

for (const harness of Object.keys(CAN)) {
  test(`${harness}: declared can matches the matrix`, /** Run the callback. */ () => {
    const a = new adapters[harness]();
    assert.deepEqual(a.can, CAN[harness]);
  });

  test(`${harness}: feeds the expected parser entry point`, /** Run the callback. */ () => {
    assert.equal(new adapters[harness]().entry, ENTRY[harness]);
  });

  test(`${harness}: import normalizes + appends + validates + tags source/adapter + emits transcript.ingested`, /** Run the callback. */ async () => {
    const a = new adapters[harness]();
    const ctx = await openTempDb();
    try {
      const res = await a.import(readTranscript(IMPORT_FIXTURE[harness]), { db: ctx.db, sessionId: 'ses_TEST' });
      assert.ok(res.ok, `import should succeed: ${JSON.stringify(res)}`);
      const appended = await allEvents(ctx.db);
      assert.ok(appended.length > 1, 'at least one event + the transcript.ingested summary');

      for (const e of appended) {
        assert.doesNotThrow(/** Run the callback. */ () => EventInput.parse(e), `appended event must validate: ${JSON.stringify(e).slice(0, 140)}`);
        assert.equal(e.source, 'transcript', 'on-disk source tag');
        assert.equal(e.adapter, harness, 'adapter id tag');
      }
      const last = appended.at(-1);
      assert.equal(last.type, 'transcript.ingested');
      assert.equal(last.payload.count, appended.length - 1);
      assert.equal(res.value.transcriptComplete, harness !== 'cursor', 'Cursor transcript is incomplete; others complete');
    } finally {
      await ctx.cleanup();
    }
  });
}

test('OpenCode tail is capability-gated → SUMO_CAP_UNSUPPORTED (never throws/fakes)', /** Verify OpenCode tail is capability-gated → SUMO_CAP_UNSUPPORTED (never throws/fakes). */ async () => {
  const ctx = await openTempDb();
  try {
    const r = new adapters.opencode().tail('/nonexistent/path.jsonl', { db: ctx.db });
    assert.ok(isResult(r) && r.ok === false);
    assert.equal(r.code, CAP_UNSUPPORTED);
  } finally {
    await ctx.cleanup();
  }
});

test('correlation signals are extracted per-harness from the real shape', /** Verify correlation signals are extracted per-harness from the real shape. */ () => {
  const claude = new adapters['claude-code']().signals({ records: readTranscript('claude-code/file/turn.jsonl') });
  assert.equal(claude.nativeId, 'b06f2b01-de75-4950-b7c7-8011e0d74fc9');
  assert.equal(claude.cwd, '/tmp/sumo-capture');
  assert.equal(typeof claude.tsStart, 'number');

  const codex = new adapters.codex().signals({ records: readTranscript('codex/file/turn.jsonl') });
  assert.equal(codex.nativeId, '019eecde-c391-7d41-bc56-fc59f3296d6c');
  assert.equal(codex.cwd, '/tmp/sumo-capture');
  assert.deepEqual(new adapters.codex().signals({ records: [] }), {});

  const copilot = new adapters.copilot().signals({
    transcriptPath: '/tmp/home/.copilot/session-state/9f1a00d8-bc22-43ae-874b-bde23d464931/events.jsonl',
    records: readTranscript('copilot/file/turn.jsonl')
  });
  assert.equal(copilot.nativeId, '9f1a00d8-bc22-43ae-874b-bde23d464931');
  assert.equal(copilot.cwd, '/tmp/sumo-capture');
  assert.equal(typeof copilot.tsStart, 'number');

  const copilotWorkspace = new adapters.copilot().signals({
    transcriptPath: new URL('./fixtures/copilot/events.jsonl', import.meta.url).pathname,
    records: []
  });
  assert.equal(copilotWorkspace.nativeId, '67716e83-201a-485f-9f26-9ebb1d6c1551');
  assert.equal(copilotWorkspace.cwd, '/tmp/sumo-capture');
  assert.equal(copilotWorkspace.tsStart, Date.parse('2026-06-29T18:24:45.083Z'));
  assert.equal(copilotWorkspace.tsEnd, Date.parse('2026-06-29T18:24:47.370Z'));

  const copilotDirOnly = new adapters.copilot().signals({
    transcriptPath: '/tmp/home/.copilot/session-state/native-from-dir/events.jsonl',
    records: []
  });
  assert.deepEqual(copilotDirOnly, { nativeId: 'native-from-dir' });
  assert.deepEqual(new adapters.copilot().signals(), {});
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = '/tmp/sumo-copilot-home';
  try {
    const copilotArtifacts = new adapters.copilot();
    assert.equal(copilotArtifacts.transcriptRoot(), path.join('/tmp/sumo-copilot-home', 'session-state'));
    assert.equal(copilotArtifacts.planGlob, path.join('/tmp/sumo-copilot-home', 'session-state', '*', 'plan.md'));
    assert.deepEqual(copilotArtifacts.configFiles, [path.join('/tmp/sumo-copilot-home', 'config.json')]);
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }

  // Cursor has no in-record metadata → signals come from the transcript PATH.
  const cursor = new adapters.cursor().signals({
    transcriptPath: '/home/u/.cursor/projects/my-proj/agent-transcripts/abc123/abc123.jsonl'
  });
  assert.deepEqual(cursor, { project: 'my-proj', nativeId: 'abc123' });

  const opencode = new adapters.opencode().signals({ records: readTranscript('opencode/stream/turn.jsonl') });
  assert.equal(opencode.nativeId, 'ses_2c1040e3dffeQGhjI7iEhHX8n1');
  assert.equal(opencode.cwd, '/private/tmp/example-live-opencode');
  assert.deepEqual(new adapters.opencode().signals({ records: [] }), {});
});

test('plan summarize — Cursor frontmatter is indexed; Claude headings are indexed', /** Verify plan summarize — Cursor frontmatter is indexed; Claude headings are indexed. */ async () => {
  // Cursor: YAML frontmatter → name/overview/todos[{id,status}]/isProject.
  const ctx = await openTempDb();
  try {
    const cres = await plan(ctx.db, { path: new URL('./fixtures/cursor/plan/sample.plan.md', import.meta.url).pathname, harness: 'cursor', sessionId: 'ses_TEST' });
    assert.ok(cres.ok);
    assert.equal(cres.value.summary.name, 'workspace cache cleanup');
    assert.equal(cres.value.summary.todoCount, 3);
    assert.deepEqual(cres.value.summary.todos[0], { id: 'config-cleanup', status: 'completed' });
    const planEvt = (await allEvents(ctx.db)).find(/** Find a matching item. */ (e) => e.type === 'plan.ingested');
    assert.ok(planEvt && planEvt.payload.planRef.endsWith('sample.plan.md'), 'plan linked by path, not copied');
    // The plan body is NOT copied into the event — only a structural summary.
    assert.equal(JSON.stringify(planEvt).includes('## Problem'), false);
  } finally {
    await ctx.cleanup();
  }

  // Claude: no frontmatter → title + section headings.
  const summary = parse(
    '# Build: Sumo config resolver\n\n## Context\n\nbody\n\n## Verification\n\nrun tests',
    'claude-code'
  );
  assert.equal(summary.title, 'Build: Sumo config resolver');
  assert.deepEqual(summary.sections, ['Context', 'Verification']);
});

test('plan ingest handles malformed frontmatter, omitted session ids, provided text and IO failures', /** Verify plan ingest handles malformed frontmatter, omitted session ids, provided text and IO failures. */ async () => {
  const malformed = parse('---\n: bad: yaml\n---\n# Ignored body', 'cursor');
  assert.deepEqual(malformed.todos, []);
  assert.equal(malformed.todoCount, 0);

  const partial = parse('---\nname: compact\nisProject: false\ntodos:\n  - body: no indexed fields\noverview: ' + 'x'.repeat(400) + '\n---\n', 'cursor');
  assert.equal(partial.name, 'compact');
  assert.equal(partial.isProject, false);
  assert.equal(partial.overview.length, 280);
  assert.deepEqual(partial.todos, [{}]);

  const ctx = await openTempDb();
  try {
    const ingested = await plan(ctx.db, { path: '/virtual/plan.md', harness: 'claude-code', text: '# Title\n\n## Step' });
    assert.equal(ingested.ok, true);
    const event = (await allEvents(ctx.db)).find(/** Find a matching item. */ (e) => e.type === 'plan.ingested');
    assert.equal(event.sessionId, undefined);
    assert.equal(event.payload.sessionId, undefined);
    assert.equal(event.payload.summary.title, 'Title');

    const missing = await plan(ctx.db, { path: '/definitely/missing/sumo-plan.md', harness: 'claude-code' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'SUMO_IO');
  } finally {
    await ctx.cleanup();
  }
});
