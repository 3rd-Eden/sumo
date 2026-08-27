/**
 * The one parametrized conformance suite over the harness adapters (CONVENTIONS §4). It runs
 * against REAL captured fixtures (capture-first, §3f) — reusing `sumo/transcript`'s committed stream
 * and file captures, which ARE the inbound transport frames a harness `read()` consumes. No mocked
 * harness payloads and no invented harness implementations.
 *
 * Asserts: (1) declared `can` matches the expected matrix; (2) `read()`→`toEvent()` validates against
 * the daemon's `EventInput`; (3) unsupported ops degrade to `SUMO_CAP_UNSUPPORTED` (never throw);
 * (4) the dedupe key REPRODUCES the parser-level identities `sumo/transcript` already proves;
 * (5) `capture()` is pipe-only; (6) capability axes (`canSendKey` vs `observationSource`) are
 * independent. Cross-source collapse vs the on-disk source is the daemon's job and is fully provable
 * only once `agent-artifacts` (spec 09) exists — noted where it bites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { adapters } from '../src/index.mjs';
import { Harness } from '../src/base/Harness.mjs';
import { installClaudeHooks } from '../src/install/claude.mjs';
import { installCodexHooks } from '../src/install/codex.mjs';
import { installCursorHooks } from '../src/install/cursor.mjs';
import { installCopilotHooks } from '../src/install/copilot.mjs';
import { isResult, CAP_UNSUPPORTED } from '../src/base/schema.mjs';
import { adapters as transcriptAdapters } from 'sumo/transcript';
import { EventInput } from 'sumo/db';
import { findSecrets } from '../../transcript/test/scrub.mjs';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(DIR, '..', '..', 'transcript', 'test', 'fixtures');
/** Implement readJsonl. */ function readJsonl(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => JSON.parse(l)); }

test('base Harness defaults declare unsupported behavior honestly', /** Verify base Harness defaults declare unsupported behavior honestly. */ async () => {
  const harness = new Harness();

  assert.deepEqual(await harness.available(), { status: 'unknown' });
  assert.equal(harness.interactiveResumeArgv('native-session'), null);
  assert.deepEqual(harness.toNativeRequest('NativeEvent', { raw: true }), {
    action: 'tool',
    payload: {},
    ext: { native: { raw: true } }
  });
  assert.deepEqual(harness.toNativeResponse({ event: { type: 'noop' } }, 'NativeEvent', {}), {
    stdout: '',
    exitCode: 0,
    diagnostics: []
  });
  assert.equal(harness.toObservation('NativeEvent', {}), null);
  assert.throws(/** Run the callback. */ () => harness.parser, { code: 'SUMO_NO_PARSER' });
  harness.hookEvents = { PermissionRequest: { kind: 'decide', action: 'approval' } };
  assert.deepEqual(harness.toNativeRequest('PermissionRequest', { request: 'allow' }), {
    action: 'approval',
    payload: {},
    ext: { native: { request: 'allow' } }
  });
  assert.deepEqual(harness.capabilitiesFor('interactive', { tmuxAvailable: true }), {
    canSendKey: false,
    canCapture: false,
    canApprove: false,
    canCancel: false,
    canDefer: false,
    canInjectContext: false,
    observationSource: 'transcript-file',
    transcriptComplete: true,
    steeringVerified: false
  });
  assert.throws(/** Run the callback. */ () => harness.write({ kind: 'prompt', text: 'hi' }), { code: 'SUMO_NOT_IMPLEMENTED' });
  await assert.rejects(/** Run the callback. */ () => harness.run('hi'), { code: 'SUMO_NO_TRANSPORT' });

  const event = harness.toEvent({ type: 'session.message', payload: { role: 'assistant', text: 'hi' }, ts: 0 });
  assert.equal(event.sessionId, undefined);
  assert.equal(event.ts, 0);
  assert.equal(event.source, 'session');
  const nativeEvent = harness.toEvent({ type: 'session.started', sessionId: 'native-1', ext: { captured: true } }, 'ses_base');
  assert.equal(nativeEvent.sessionId, 'ses_base');
  assert.deepEqual(nativeEvent.ext, { captured: true, nativeSessionId: 'native-1' });
});

/** The capability matrix each adapter's declared `can` must match. */
const CAN = {
  'claude-code': { stream: true, injectStdin: true, hooks: true, defer: true, key: true, capture: true, cancel: true, resume: true, providers: ['anthropic'] },
  cursor: { stream: true, injectStdin: false, hooks: true, key: true, capture: true, cancel: true, resume: true, providers: ['openai', 'anthropic'] },
  codex: { stream: true, injectStdin: true, hooks: true, defer: false, key: false, capture: false, approve: true, cancel: true, resume: true, providers: ['openai'] },
  copilot: { stream: true, injectStdin: false, hooks: true, defer: false, key: false, capture: false, approve: true, cancel: true, resume: true, providers: ['openai', 'anthropic'] }
};

/** Committed transcript fixtures reused as inbound frames, per harness/entry. */
const FIXTURES = {
  'claude-code': {
    stream: ['claude-code/stream/turn.jsonl'],
    file: ['claude-code/file/turn.jsonl', 'claude-code/file/tools.jsonl']
  },
  codex: { stream: ['codex/stream/turn.jsonl', 'codex/stream/tool.jsonl'], file: ['codex/file/turn.jsonl'] },
  cursor: { stream: ['cursor/stream/turn.jsonl'], file: ['cursor/file/turn.jsonl'] },
  copilot: { stream: ['copilot/stream/turn.jsonl', 'copilot/stream/tool.jsonl', 'copilot/stream/permission-request.jsonl'], file: [] }
};

/** Drive an adapter's read()→toEvent() over every record of a fixture; return the EventInputs (live stream). */
function eventsFor(harness, rel) {
  const a = new adapters[harness]();
  const out = [];
  for (const frame of readJsonl(rel)) for (const evt of a.read(frame)) out.push(a.toEvent(evt, 'ses_conf'));
  return out;
}

/**
 * The on-disk source (spec 09) doesn't exist yet, so simulate it: run the harness's transcript parser
 * `file()` entry directly and map through the SAME adapter `toEvent()` — proving the dedupe convention
 * is shared, so live+disk would collapse at the daemon. This layer itself only reads the live stream.
 */
function fileEventsFor(harness, rel) {
  const a = new adapters[harness]();
  const P = new transcriptAdapters[harness]();
  const out = [];
  for (const rec of readJsonl(rel)) {
    const res = P.file(rec);
    if (isResult(res)) continue;
    for (const evt of res) out.push(a.toEvent(evt, 'ses_conf'));
  }
  return out;
}

/** Implement assistant. */ function assistant(events) { return events.find(/** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'); }

for (const harness of Object.keys(CAN)) {
  test(`${harness}: declared can matches the expected capability matrix`, /** Run the callback. */ () => {
    const a = new adapters[harness]();
    assert.deepEqual(a.can, CAN[harness]);
  });

  test(`${harness}: read()→toEvent() output validates against the daemon EventInput`, /** Run the callback. */ () => {
    for (const rel of FIXTURES[harness].stream) {
      const events = eventsFor(harness, rel);
      assert.ok(events.length > 0, `${rel} produced no events`);
      for (const e of events) {
        assert.doesNotThrow(/** Run the callback. */ () => EventInput.parse(e), `${rel}: ${JSON.stringify(e).slice(0, 120)}`);
        assert.equal(e.source, 'session');
        assert.equal(e.adapter, harness);
        assert.ok(e.dedupe && e.dedupe.length > 0, 'every event carries a dedupe key ()');
      }
    }
  });

  test(`${harness}: dedupe is stable across repeated reads of the same frames`, /** Run the callback. */ () => {
    const rel = FIXTURES[harness].stream[0];
    const a = eventsFor(harness, rel).map(/** Map one item. */ (e) => e.dedupe);
    const b = eventsFor(harness, rel).map(/** Map one item. */ (e) => e.dedupe);
    assert.deepEqual(a, b, 'same frames → identical dedupe keys');
  });
}

// (4) Dedupe REPRODUCES the parser identities transcript proves: Claude's natural-id stream↔file
// collapse must hold through the harness base's own dedupe computation.
test('claude-code: base dedupe reproduces the stream↔file natural-id collapse', /** Verify claude-code: base dedupe reproduces the stream↔file natural-id collapse. */ () => {
  const s = assistant(eventsFor('claude-code', FIXTURES['claude-code'].stream[0]));
  const f = assistant(fileEventsFor('claude-code', FIXTURES['claude-code'].file[0]));
  assert.ok(s && f, 'assistant message present in both surfaces');
  assert.equal(s.dedupe, f.dedupe, 'identical dedupe key → daemon collapses live+disk');
  assert.match(s.dedupe, /^msg:/, 'natural-id key, not a content hash');
});

// codex: same normalized payload but no shared natural id → keys differ (collapse needs spec 09).
test('codex: documented — no shared natural id across surfaces (collapse pending spec 09)', /** Verify codex: documented — no shared natural id across surfaces (collapse pending spec 09). */ () => {
  const s = assistant(eventsFor('codex', FIXTURES.codex.stream[0]));
  const f = assistant(fileEventsFor('codex', FIXTURES.codex.file[0]));
  assert.ok(s && f, 'assistant message present in both surfaces');
  assert.deepEqual(s.payload, f.payload, 'normalized payload agrees (gap-merge is safe)');
  assert.notEqual(s.dedupe, f.dedupe, 'no shared natural id → keys differ until spec-09 correlation');
});

// (3) CapabilitySchema degradation at the adapter boundary — unsupported ops are a Result, never a throw.
test('cursor: a follow-up prompt degrades to SUMO_CAP_UNSUPPORTED (no stdin streaming)', /** Verify cursor: a follow-up prompt degrades to SUMO_CAP_UNSUPPORTED (no stdin streaming). */ async () => {
  const r = await new adapters.cursor().write({ kind: 'prompt', text: 'again' });
  assert.ok(isResult(r) && r.ok === false);
  assert.equal(r.code, CAP_UNSUPPORTED);
});

test('codex: key injection degrades to SUMO_CAP_UNSUPPORTED (no terminal)', /** Verify codex: key injection degrades to SUMO_CAP_UNSUPPORTED (no terminal). */ async () => {
  const r = await new adapters.codex().write({ kind: 'key', name: 'Enter' });
  assert.ok(isResult(r) && r.ok === false);
  assert.equal(r.code, CAP_UNSUPPORTED);
});

test('copilot: key injection degrades to SUMO_CAP_UNSUPPORTED (server kind, no terminal)', /** Verify copilot: key injection degrades to SUMO_CAP_UNSUPPORTED (server kind, no terminal). */ async () => {
  const copilot = new adapters.copilot();
  const prompt = await copilot.write({ kind: 'prompt', text: 'again' });
  assert.ok(isResult(prompt) && prompt.ok === false);
  assert.equal(prompt.code, 'SUMO_SESSION_DEAD');

  const command = await copilot.write({ kind: 'command', line: 'again' });
  assert.ok(isResult(command) && command.ok === false);
  assert.equal(command.code, 'SUMO_SESSION_DEAD');

  const key = await copilot.write({ kind: 'key', name: 'Enter' });
  assert.ok(isResult(key) && key.ok === false);
  assert.equal(key.code, CAP_UNSUPPORTED);

  assert.deepEqual(await copilot.write({ kind: 'noop' }), { ok: true });
});

test('copilot: stream assistant.message normalises to session.message with natural id', /** Verify copilot: stream assistant.message normalises to session.message with natural id. */ () => {
 const events = eventsFor('copilot', 'copilot/stream/turn.jsonl');
 const message = events.find(/** Find a matching item. */ (event) => event.type === 'session.message');
 assert.ok(message, 'captured assistant.message normalizes to session.message');
 assert.equal(message.payload.role, 'assistant');
 assert.equal(message.payload.text, 'HELLO');
 assert.equal(message.dedupe, 'msg:ses_conf:3254d66e-aa32-4a65-9812-63428c96a505');
 assert.doesNotThrow(/** Run the callback. */ () => EventInput.parse(message));
});

test('copilot: tool execution start and complete share a natural id for dedupe', /** Verify copilot: tool execution start and complete share a natural id for dedupe. */ () => {
 const events = eventsFor('copilot', 'copilot/stream/tool.jsonl').filter(/** Select matching items. */ (event) => event.type === 'session.tool');
 assert.equal(events.length, 2);
 assert.ok(events.every(/** Test whether every item matches. */ (event) => event.dedupe === 'call:ses_conf:toolu_bdrk_01Mtc5dpAUUA64ihS9UWx8WU'));
 assert.ok(events.some(/** Test whether an item matches. */ (event) => event.payload.tool.input?.command === 'printf sumo-tool-capture'));
 assert.ok(events.some(/** Test whether an item matches. */ (event) => /sumo-tool-capture/.test(event.payload.tool.output?.content ?? '')));
});

test('copilot: permission.requested normalises to session.approval-requested through the harness path', /** Verify copilot: permission.requested normalises to session.approval-requested through the harness path. */ () => {
 const event = eventsFor('copilot', 'copilot/stream/permission-request.jsonl')[0];
 assert.equal(event.type, 'session.approval-requested');
 assert.equal(event.payload.requestId, '11111111-2222-4333-8444-555555555555');
 assert.equal(event.payload.permissionRequest.kind, 'shell');
 assert.equal(event.dedupe, 'session.approval-requested:ses_conf:11111111-2222-4333-8444-555555555555');
 assert.doesNotThrow(/** Run the callback. */ () => EventInput.parse(event));
});

// (6) CapabilitySchema axes are independent: interactive control vs clean event source.
test('capability axes are independent (canSendKey vs observationSource)', /** Verify capability axes are independent (canSendKey vs observationSource). */ () => {
  const claudeDefault = new adapters['claude-code']().capabilitiesFor('default');
  assert.equal(claudeDefault.observationSource, 'event-stream');
  assert.equal(claudeDefault.canSendKey, false, 'no key injection without a pane');
  assert.equal(claudeDefault.canCapture, true, 'pipe can snapshot raw stdout');

  // Interactive control runs through a tmux pane: observation flips to the transcript regardless, but
  // key/capture are advertised ONLY when tmux is actually present (declare-don't-fake, ).
  const claudeInteractiveNoTmux = new adapters['claude-code']().capabilitiesFor('interactive');
  assert.equal(claudeInteractiveNoTmux.observationSource, 'transcript-file', 'pane mode observes via the transcript (09)');
  assert.equal(claudeInteractiveNoTmux.canSendKey, false, 'no key injection without tmux present');

  const claudeInteractive = new adapters['claude-code']().capabilitiesFor('interactive', { tmuxAvailable: true });
  assert.equal(claudeInteractive.observationSource, 'transcript-file', 'pane mode observes via the transcript (09)');
  assert.equal(claudeInteractive.canSendKey, true, 'pane (with tmux) enables key injection');

  const codexCaps = new adapters.codex().capabilitiesFor('default');
  assert.equal(codexCaps.canApprove, true, 'server kind has approvals');
  assert.equal(codexCaps.canCapture, false, 'server kind has no screen to capture');

  const copilotCaps = new adapters.copilot().capabilitiesFor('default');
  assert.equal(copilotCaps.canApprove, true, 'copilot approval is backed by the SDK pending-permission RPC');
});

test('adapters verify Sumo-managed hook installs from project-local config', /** Verify spawn-time steering verification reflects installed hook files. */ () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-verify-'));
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const cases = [
      {
        name: 'claude-code',
        adapter: () => new adapters['claude-code'](),
        install: (projectDir) => installClaudeHooks({ projectDir })
      },
      {
        name: 'codex',
        adapter: () => new adapters.codex(),
        install: (projectDir) => installCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } })
      },
      {
        name: 'cursor',
        adapter: () => new adapters.cursor(),
        install: (projectDir) => installCursorHooks({ projectDir })
      },
      {
        name: 'copilot',
        adapter: () => new adapters.copilot(),
        install: (projectDir) => installCopilotHooks({ projectDir })
      }
    ];

    for (const entry of cases) {
      const missingDir = path.join(root, `${entry.name}-missing`);
      fs.mkdirSync(missingDir, { recursive: true });
      const missing = entry.adapter().verifySteering({ cwd: missingDir });
      assert.equal(missing.ok, false, `${entry.name} reports unverified before install`);
      assert.ok(missing.diagnostics.some((diag) => diag.code === 'SUMO_STEERING_UNVERIFIED'), `${entry.name} records unverified diagnostic`);

      const installedDir = path.join(root, `${entry.name}-installed`);
      fs.mkdirSync(installedDir, { recursive: true });
      const installed = entry.install(installedDir);
      assert.equal(installed.ok, true, `${entry.name} install succeeds`);
      assert.deepEqual(entry.adapter().verifySteering({ cwd: installedDir }), { ok: true, diagnostics: [] }, `${entry.name} verifies installed hooks`);
    }
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// (7) No fixture the suite reads leaks a secret-looking value (the captures are real, so audit them).
test('no fixture frame the suite consumes leaks a secret-looking value', /** Verify no fixture frame the suite consumes leaks a secret-looking value. */ () => {
  for (const harness of Object.keys(FIXTURES)) {
    for (const entry of ['stream', 'file']) {
      for (const rel of FIXTURES[harness][entry]) {
        for (const rec of readJsonl(rel)) {
          const hits = findSecrets(rec);
          assert.equal(hits.length, 0, `${rel}: ${hits[0] ?? ''}`);
        }
      }
    }
  }
});
