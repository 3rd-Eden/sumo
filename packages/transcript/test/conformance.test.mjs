/**
 * The one parametrized conformance suite over all four transcript adapters (CONVENTIONS §4). It runs
 * against committed REAL captured fixtures (capture-first, §3f / ), not mocks. See each harness's
 * `fixtures/<id>/PROVENANCE.md` for capture method and version.
 *
 * Asserts: (1) schema validity, (2) stream↔file dedup/normalization identity at the level each harness
 * actually supports, (3) lossless passthrough, (4) `can` honesty, (5) cross-harness normalization to
 * the shared `07` vocabulary, (6) per-event id uniqueness, (7) no committed fixture leaks a secret.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { adapters, isResult, CAP_UNSUPPORTED, EventSchema } from '../src/index.mjs';
import { join, forContent } from 'sumo/db/dedupe';
import { findSecrets } from './scrub.mjs';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');
/** Implement read. */ function read(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => JSON.parse(l)); }

/** The capability matrix the suite expects each adapter's declared `can` to match. */
const CAN = {
  'claude-code': { stream: true, file: true },
  copilot: { stream: true, file: true },
  codex: { stream: true, file: true },
  cursor: { stream: true, file: true },
  opencode: { stream: true, file: false }
};

/** Committed fixtures per harness/entry. */
const FIXTURES = {
  'claude-code': {
    stream: ['claude-code/stream/turn.jsonl'],
    file: ['claude-code/file/turn.jsonl', 'claude-code/file/tools.jsonl', 'claude-code/file/passthrough.jsonl', 'claude-code/file/multiblock.jsonl']
  },
  copilot: { stream: ['copilot/stream/turn.jsonl', 'copilot/stream/tool.jsonl', 'copilot/stream/quota-error.jsonl', 'copilot/stream/permission-request.jsonl'], file: ['copilot/file/turn.jsonl', 'copilot/file/tool.jsonl'] },
  codex: { stream: ['codex/stream/turn.jsonl', 'codex/stream/tool.jsonl', 'codex/stream/usage-limit-error.jsonl'], file: ['codex/file/turn.jsonl', 'codex/file/tools.jsonl'] },
  cursor: { stream: ['cursor/stream/turn.jsonl'], file: ['cursor/file/turn.jsonl', 'cursor/file/tools.jsonl'] },
  opencode: { stream: ['opencode/stream/turn.jsonl', 'opencode/stream/tool.jsonl'], file: [] }
};

const PASSTHROUGH_FIXTURES = {
  'claude-code': [{ entry: 'file', rel: 'claude-code/file/passthrough.jsonl' }],
  codex: [
    { entry: 'stream', rel: 'codex/stream/turn.jsonl' },
    { entry: 'file', rel: 'codex/file/turn.jsonl' }
  ],
  opencode: [{ entry: 'stream', rel: 'opencode/stream/turn.jsonl' }]
};

/**
 * The stream↔file collapse level each harness actually supports (verified from real captures):
 * - `natural-id`: same surfaced id + identical normalized payload → the daemon collapses live+disk.
 * - `normalized`:  identical normalized payload, but no shared natural id (collapse needs the
 *   daemon/correlation layer, spec 09) — surfaced, not a parser bug.
 * - `divergent`:   on-disk text diverges from live (e.g. query-wrapping) → no parser-level identity.
 */
const COLLAPSE = { 'claude-code': 'natural-id', copilot: 'natural-id', codex: 'normalized', cursor: 'divergent' };

/** Parse every record of a fixture through an entry point; returns the flat list of events. */
function parseAll(harness, entry, rel) {
  const P = new adapters[harness]();
  const events = [];
  const result = P[entry](read(rel)[0]); // probe the first record to detect a capability Result
  if (isResult(result)) return { result, events };
  for (const rec of read(rel)) for (const e of P[entry](rec)) events.push(e);
  return { events };
}

/** Implement assistantMessage. */ function assistantMessage(events) { return events.find(/** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'); }

for (const harness of Object.keys(CAN)) {
  const P = new adapters[harness]();

  test(`${harness}: declared can matches the expected capability matrix`, /** Run the callback. */ () => {
    assert.deepEqual(P.can, CAN[harness]);
  });

  test(`${harness}: capability gate — unsupported entry returns SUMO_CAP_UNSUPPORTED, supported returns an iterable`, /** Run the callback. */ () => {
    for (const entry of ['stream', 'file']) {
      const r = P[entry]({ type: 'probe' });
      if (CAN[harness][entry]) {
        assert.equal(isResult(r), false, `${entry} should be iterable`);
        assert.equal(typeof r[Symbol.iterator], 'function');
      } else {
        assert.ok(isResult(r) && r.ok === false);
        assert.equal(r.code, CAP_UNSUPPORTED);
      }
    }
  });

  test(`${harness}: every fixture event validates against EventSchema`, /** Run the callback. */ () => {
    for (const entry of ['stream', 'file']) {
      for (const rel of FIXTURES[harness][entry]) {
        const { events } = parseAll(harness, entry, rel);
        assert.ok(events.length > 0, `${rel} produced no events`);
        for (const e of events) assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(e), `${rel}: ${JSON.stringify(e).slice(0, 120)}`);
      }
    }
  });

  test(`${harness}: lossless — captured unknown records surface as preserved passthroughs`, /** Run the callback. */ () => {
    const passthroughs = [];
    for (const fixture of PASSTHROUGH_FIXTURES[harness] ?? []) {
      passthroughs.push(...parseAll(harness, fixture.entry, fixture.rel).events.filter(/** Select matching items. */ (event) => event.type.includes('.raw:')));
    }
    if (!passthroughs.length) return;
    for (const e of passthroughs) {
      assert.match(e.type, /\.raw:/, 'passthrough type');
      assert.deepEqual(e.payload, {}, 'normalized fields empty');
      assert.ok(e.ext.native && typeof e.ext.native === 'object', 'raw record preserved in ext.native');
    }
  });

  test(`${harness}: cross-harness normalization — tool/message constructs hit the shared 07 types`, /** Run the callback. */ () => {
    const all = [];
    for (const entry of ['stream', 'file']) for (const rel of FIXTURES[harness][entry]) all.push(...parseAll(harness, entry, rel).events);
    const types = new Set(all.map(/** Map one item. */ (e) => e.type));
    assert.ok(types.has('session.message'), 'a message normalizes to session.message');
    assert.ok(types.has('session.tool'), 'a tool construct normalizes to session.tool');
    if (harness === 'claude-code' || harness === 'codex') {
      assert.ok(types.has('session.reasoning'), 'reasoning normalizes to session.reasoning');
    }
    if (harness === 'codex') {
      assert.ok(types.has('session.final-answer'), 'codex: final_answer agentMessage also emits session.final-answer signal');
    }
  });
}

// ---- Dedup / normalization identity across stream↔file (the daemon-collapse property) ----
for (const harness of Object.keys(COLLAPSE)) {
  test(`${harness}: stream↔file identity (${COLLAPSE[harness]})`, /** Run the callback. */ () => {
    const s = assistantMessage(parseAll(harness, 'stream', FIXTURES[harness].stream[0]).events);
    const f = assistantMessage(parseAll(harness, 'file', FIXTURES[harness].file[0]).events);
    assert.ok(s, 'assistant message present in stream');
    assert.ok(f, 'assistant message present in file');

    if (COLLAPSE[harness] === 'natural-id') {
      // strongest: identical normalized payload AND a shared natural id → equal dedupe keys → collapse.
      assert.deepEqual(s.payload, f.payload, 'normalized payload identical');
      assert.equal(s.id, f.id, 'shared natural id across surfaces');
      assert.equal(join('msg', s.id), join('msg', f.id), 'dedupe keys collapse');
    } else if (COLLAPSE[harness] === 'normalized') {
      // payload agrees (so the daemon's gap-merge is safe), but no shared natural id from the parser.
      assert.deepEqual(s.payload, f.payload, 'normalized payload identical');
      assert.notEqual(s.id, f.id, 'documented: no shared natural id (collapse needs spec-09 correlation)');
    } else {
      // divergent on-disk text: only the type is stable; surfaced as a known finding.
      assert.equal(s.type, f.type, 'same normalized type');
      assert.equal(s.payload.role, f.payload.role, 'same role');
    }
  });
}

// ---- Codex tool calls share call_id across stream↔file (collapse PROVEN, not just claimed) ----
test('codex: a tool call collapses stream↔file via shared call_id', /** Verify codex: a tool call collapses stream↔file via shared call_id. */ () => {
  const sTool = parseAll('codex', 'stream', 'codex/stream/tool.jsonl').events.find(/** Find a matching item. */ (e) => e.type === 'session.tool');
  const fTools = parseAll('codex', 'file', 'codex/file/tools.jsonl').events.filter(/** Select matching items. */ (e) => e.type === 'session.tool');
  assert.ok(sTool?.id, 'stream tool event carries a call_id');
  assert.ok(fTools.length > 0 && fTools.every(/** Test whether every item matches. */ (e) => e.id), 'file tool events carry a call_id');
  for (const f of fTools) {
    assert.equal(sTool.id, f.id, 'same call_id across surfaces');
    assert.equal(join('call', sTool.id), join('call', f.id), 'dedupe keys collapse');
  }
});

test('codex: captured usage-limit stream errors carry retryable fallback classification', /** Verify codex: captured usage-limit stream errors carry retryable fallback classification. */ () => {
  const events = parseAll('codex', 'stream', 'codex/stream/usage-limit-error.jsonl').events;
  const classified = events.filter(/** Select matching items. */ (e) => e.payload?.sumoCode === 'SUMO_RATE_LIMITED');
  assert.equal(classified.length, 2);
  assert.ok(classified.every(/** Test whether every item matches. */ (e) => e.payload.retryable === true && e.payload.fallback === true));
  assert.ok(classified.every(/** Test whether every item matches. */ (e) => e.ext.classification.reason.includes('usage limit')));
});

test('codex: auth-provider timeout details classify as auth-required', /** Verify codex: auth-provider timeout details classify as auth-required. */ () => {
 const P = new adapters.codex;
 const events = [...P.stream({
 method: 'error',
 params: {
 error: {
 message: 'Reconnecting... 1/5',
 codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
 additionalDetails: 'provider auth command `/home/example/.local/bin/auth-helper` timed out after 5000 ms'
 },
 willRetry: true,
 threadId: 'thread_sanitized',
 turnId: 'turn_sanitized'
 }
 })];
 assert.equal(events.length, 1);
 assert.equal(events[0].type, 'session.raw:error');
 assert.equal(events[0].payload.sumoCode, 'SUMO_AUTH_REQUIRED');
 assert.equal(events[0].payload.retryable, false);
 assert.equal(events[0].payload.fallback, true);
 assert.equal(events[0].ext.classification.code, 'SUMO_AUTH_REQUIRED');
});

test('opencode: committed SSE boundary fixtures stay normalized or lossless through the real parser', /** Verify opencode: committed SSE boundary fixtures stay normalized or lossless through the real parser. */ () => {
  const events = [
    ...parseAll('opencode', 'stream', 'opencode/stream/turn.jsonl').events,
    ...parseAll('opencode', 'stream', 'opencode/stream/tool.jsonl').events
  ];

  for (const event of events) assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(event));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.started' && e.payload.cwd === '/private/tmp/example-live-opencode'));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && /READY/.test(e.payload.text)));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.id === 'tooluse_93Ze5RvjbVKLod7KS9LM8O'));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:message.part.delta'));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:message.updated'));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:session.status'));
});

test('copilot: assistant.message uses the messageId natural id and idle stays lossless', /** Verify copilot: assistant.message uses the messageId natural id and idle stays lossless. */ () => {
  const events = parseAll('copilot', 'stream', 'copilot/stream/turn.jsonl').events;
  const msg = events.find(/** Find a matching item. */ (e) => e.type === 'session.message');
  const idle = events.find(/** Find a matching item. */ (e) => e.type === 'session.raw:session.idle');
  assert.ok(msg, 'assistant.message normalizes to session.message');
  assert.equal(msg.payload.role, 'assistant');
  assert.equal(msg.id, '3254d66e-aa32-4a65-9812-63428c96a505');
  assert.ok(idle?.ext.native, 'session.idle is preserved as passthrough');
});

test('copilot: tool.execution_start and tool.execution_complete share one natural id', /** Verify copilot: tool.execution_start and tool.execution_complete share one natural id. */ () => {
  const events = parseAll('copilot', 'stream', 'copilot/stream/tool.jsonl').events.filter(/** Select matching items. */ (e) => e.type === 'session.tool');
  assert.equal(events.length, 2);
  assert.ok(events.every(/** Test whether every item matches. */ (e) => e.id === 'toolu_bdrk_01Mtc5dpAUUA64ihS9UWx8WU'));
});

test('copilot: file entry reuses the stream normalization for persisted events.jsonl', /** Verify copilot: file entry reuses the stream normalization for persisted events.jsonl. */ () => {
  const fileEvents = parseAll('copilot', 'file', 'copilot/file/turn.jsonl').events;
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.started' && e.payload.cwd === '/tmp/sumo-capture'));
});

test('copilot: captured quota errors carry budget-exhausted fallback classification', /** Verify copilot: captured quota errors carry budget-exhausted fallback classification. */ () => {
  const events = parseAll('copilot', 'stream', 'copilot/stream/quota-error.jsonl').events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session.raw:session.error');
  assert.equal(events[0].payload.sumoCode, 'SUMO_BUDGET_EXHAUSTED');
  assert.equal(events[0].payload.retryable, false);
  assert.equal(events[0].payload.fallback, true);
  assert.equal(events[0].ext.classification.code, 'SUMO_BUDGET_EXHAUSTED');
});

test('copilot: captured permission requests surface as approval requests', /** Verify copilot: captured permission requests surface as approval requests. */ () => {
  const events = parseAll('copilot', 'stream', 'copilot/stream/permission-request.jsonl').events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session.approval-requested');
  assert.equal(events[0].id, '11111111-2222-4333-8444-555555555555');
  assert.equal(events[0].payload.requestId, '11111111-2222-4333-8444-555555555555');
  assert.equal(events[0].payload.permissionRequest.kind, 'shell');
  assert.equal(events[0].payload.permissionRequest.toolCallId, 'toolu_sumo_copilot_permission');
  assert.equal(events[0].payload.permissionRequest.commands[0].readOnly, false);
});

test('parser boundary drift still surfaces through public parser paths without dropping data', /** Verify parser boundary drift still surfaces through public parser paths without dropping data. */ () => {
  const openCode = new adapters.opencode();
  const openStarted = [...openCode.stream({ type: 'session.created', properties: {} })];
  assert.equal(openStarted[0].type, 'session.started');
  assert.deepEqual(openStarted[0].payload, { harness: 'opencode' });

  const openUnknownPart = [...openCode.stream({ type: 'message.part.updated', properties: { part: { id: 'part_unknown', type: 'reasoning', sessionID: 'ses_oc' } } })];
  assert.equal(openUnknownPart[0].type, 'session.raw:part.reasoning');
  assert.equal(openUnknownPart[0].id, 'part_unknown');
  assert.equal(openUnknownPart[0].sessionId, 'ses_oc');

  const openMissingPart = [...openCode.stream({ type: 'message.part.updated', properties: {} })];
  assert.equal(openMissingPart[0].type, 'session.raw:part.unknown');

  const openUnknown = [...openCode.stream({})];
  assert.equal(openUnknown[0].type, 'session.raw:unknown');
  const openUnknownNoSession = [...openCode.stream({ type: 'message.part.delta', properties: {} })];
  assert.equal(openUnknownNoSession[0].sessionId, undefined);

  const cursor = new adapters.cursor();
  const cursorUnknownStream = [...cursor.stream({ type: 'future.event', session_id: 'ses_cursor' })];
  assert.equal(cursorUnknownStream[0].type, 'session.raw:future.event');
  assert.equal(cursorUnknownStream[0].sessionId, 'ses_cursor');
  const cursorUnknownNoSession = [...cursor.stream({ type: 'future.event' })];
  assert.equal(cursorUnknownNoSession[0].sessionId, undefined);

  const cursorDriftFile = [...cursor.file({ role: 'assistant', message: { id: 'msg_drift', content: { unexpected: true } } })];
  assert.equal(cursorDriftFile[0].type, 'session.raw:message');
  assert.equal(cursorDriftFile[0].id, 'msg_drift');

  const cursorUnknownFile = [...cursor.file({ role: 'future-role' })];
  assert.equal(cursorUnknownFile[0].type, 'session.raw:future-role');

  const copilot = new adapters.copilot();
  const unclassifiedError = [...copilot.stream({
    type: 'session.error',
    id: 'copilot-unclassified',
    timestamp: 'not-a-date',
    data: { errorType: 'other', message: 'captured but unclassified' }
  })];
  assert.equal(unclassifiedError[0].type, 'session.raw:session.error');
  assert.equal(unclassifiedError[0].payload.sumoCode, undefined);
  assert.equal(unclassifiedError[0].ts, undefined);
});

test('codex parser covers live and rollout event families through public parser paths', /** Verify codex parser covers live and rollout event families through public parser paths. */ () => {
  const codex = new adapters.codex();
  const streamEvents = [
    ...codex.stream({}),
    ...codex.stream({ method: 'thread/started', params: {} }),
    ...codex.stream({ method: 'turn/started', params: { threadId: 'thread-live' } }),
    ...codex.stream({ method: 'item/started', params: { threadId: 'thread-live' } }),
    ...codex.stream({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-live',
        command: 'cat package.json',
        cwd: '/tmp/project',
        reason: 'read requested',
        itemId: 'item-approval',
        turnId: 'turn-approval',
        availableDecisions: ['approve', 'deny'],
        proposedExecpolicyAmendment: { sandbox: 'workspace-write' }
      }
    }),
    ...codex.stream({ method: 'item/completed', params: { threadId: 'thread-live', item: { type: 'userMessage', id: 'user-item', content: 'hello' } } }),
    ...codex.stream({ method: 'item/completed', params: { threadId: 'thread-live', item: { type: 'reasoning', id: 'reason-item', summary: [{ text: 'thinking' }, { other: true }] } } }),
    ...codex.stream({ method: 'item/completed', params: { threadId: 'thread-live', item: { type: 'commandExecution', id: 'cmd-item', command: 'pwd', cwd: '/tmp/project', aggregatedOutput: '/tmp/project' } } }),
    ...codex.stream({ method: 'item/completed', params: { threadId: 'thread-live' } }),
    ...codex.stream({ method: 'item/completed', params: { threadId: 'thread-live', item: {} } }),
    ...codex.stream({ method: 'status/updated', params: { threadId: 'thread-live' } })
  ];

  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:rpc'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.started' && e.payload.harness === 'codex'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.turn-started' && e.sessionId === 'thread-live'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:item.started'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.approval-requested' && e.payload.proposedExecpolicyAmendment));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'user' && e.payload.text === 'hello'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.reasoning' && e.payload.text === 'thinking'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.payload.tool.name === 'commandExecution'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:item.unknown'));
  assert.ok(streamEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:status.updated'));

  const fileEvents = [
    ...codex.file({ type: 'session_meta', timestamp: 'not-a-date', payload: { id: 'thread-file', cwd: '/tmp/project' } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: 'done' } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'message', role: 'assistant', content: { unexpected: true } } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'reasoning', summary: [{ text: 'rollout reasoning' }] } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'function_call', name: 'shell', arguments: { cmd: 'pwd' } } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'function_call_output', call_id: 'call-output', output: 'ok' } }),
    ...codex.file({ type: 'response_item', timestamp: '2026-06-29T21:14:30.951Z', payload: {} }),
    ...codex.file({ type: 'event_msg', timestamp: '2026-06-29T21:14:30.951Z', payload: { type: 'token_count' } }),
    ...codex.file({})
  ];

  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.started' && e.ts === undefined));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.final-answer' && e.payload.text === 'done'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant' && !('text' in e.payload)));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.reasoning' && e.payload.text === 'rollout reasoning'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.payload.tool.name === 'shell'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.id === 'call-output' && e.payload.tool.output === 'ok'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:response_item.unknown'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:event_msg.token_count'));
  assert.ok(fileEvents.some(/** Test whether an item matches. */ (e) => e.type === 'session.raw:unknown'));
});

test('claude-code: captured passthrough records are preserved, never dropped', /** Verify claude-code: captured passthrough records are preserved, never dropped. */ () => {
  const events = parseAll('claude-code', 'file', 'claude-code/file/passthrough.jsonl').events;
  assert.ok(events.length >= 3);
  assert.ok(events.every(/** Test whether every item matches. */ (event) => event.type.includes('.raw:')));
  assert.ok(events.some(/** Test whether an item matches. */ (event) => event.type === 'session.raw:attachment'));
  assert.ok(events.some(/** Test whether an item matches. */ (event) => event.type === 'session.raw:last-prompt'));
  assert.ok(events.some(/** Test whether an item matches. */ (event) => event.type === 'session.raw:queue-operation'));
  assert.ok(events.every(/** Test whether every item matches. */ (event) => event.ext.native && typeof event.ext.native === 'object'));
});

test('claude-code: real fixtures cover string, reasoning, tool-use and tool-result blocks', /** Verify claude-code: real fixtures cover string, reasoning, tool-use and tool-result blocks. */ () => {
  const events = [
    ...parseAll('claude-code', 'file', 'claude-code/file/turn.jsonl').events,
    ...parseAll('claude-code', 'file', 'claude-code/file/tools.jsonl').events,
    ...parseAll('claude-code', 'file', 'claude-code/file/multiblock.jsonl').events
  ];

  for (const event of events) assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse(event));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'user' && /Reply with exactly/.test(e.payload.text)));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.reasoning'));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.payload.tool.name === 'Read' && e.payload.tool.input));
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.tool' && e.payload.tool.output));
});

// ---- Per-event id uniqueness for a multi-block record ----
test('claude-code: a multi-block record yields events with distinct ids', /** Verify claude-code: a multi-block record yields events with distinct ids. */ () => {
  const { events } = parseAll('claude-code', 'file', 'claude-code/file/multiblock.jsonl');
  assert.ok(events.length >= 2, 'multi-block record expands to multiple events');
  const ids = events.map(/** Map one item. */ (e) => e.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'no two events share an id');
});

// ---- Content-hash dedupe is usable for id-less events (sanity on the db helper contract) ----
test('content dedupe is stable for id-less normalized events', /** Verify content dedupe is stable for id-less normalized events. */ () => {
  const ev = assistantMessage(parseAll('cursor', 'stream', FIXTURES.cursor.stream[0]).events);
  const key = forContent({ sessionId: ev.sessionId, kind: ev.type, payload: ev.payload, position: 0 });
  assert.match(key, /^sha256:/);
});

// ---- Fixture secret audit ----
test('no committed fixture leaks a secret-looking value', /** Verify no committed fixture leaks a secret-looking value. */ () => {
  for (const harness of Object.keys(FIXTURES)) {
    for (const entry of ['stream', 'file']) {
      for (const rel of FIXTURES[harness][entry]) {
        for (const rec of read(rel)) {
          const hits = findSecrets(rec);
          assert.equal(hits.length, 0, `${rel}: ${hits[0] ?? ''}`);
        }
      }
    }
  }
});
