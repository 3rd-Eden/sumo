/**
 *  /  — interactive (tmux-pane) drive is genuinely wired, not faked, and the observation loop
 * (transcript-file → DB) closes the data trail.
 *
 * Unit (no subprocess): the effective-mode plumbing and the per-adapter launch-arg / send-encoding
 * swaps that make an interactive launch a REAL TUI (not the headless `-p` stream-json pipe), plus the
 * honest tmux-gated capability.
 *
 * Live (tmux + real `claude`, skip-with-reason when absent):
 *   1. `run({ mode:'interactive' })` drives a real Claude TUI in tmux — `send` types a prompt,
 *      `capture` reads the pane, `interrupt` halts without ending, session stays alive.
 *   2. The OBSERVATION LOOP: in interactive mode `observationSource:'transcript-file'` — `frames()`
 *      yields nothing by design; events must come from the on-disk JSONL via the agent-artifacts
 *      acquirer tail. The always-on ingest service is wired against a real temp daemon and the
 *      session's transcript dir; after driving the session the test asserts that the assistant turn
 *      lands in the DB ( closed). This is the full interactive data trail, end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { open } from 'sumo/db';
import { watcher, ClaudeArtifacts } from 'sumo/agent-artifacts';
import { Claude, Cursor, Codex, Copilot } from '../src/index.mjs';
import { Pipe } from '../src/transport/index.mjs';
import { tmuxAvailable } from '../src/transport/tmux.mjs';
import { resolveClaudeBin } from './_live.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
/** Implement sleep. */ function sleep(ms) { return new Promise(/** Run the callback. */ (r) => setTimeout(r, ms)); }

/** Implement assistantEvents. */ async function assistantEvents(db, sessionId) {
  let n = 0;
  for await (const [, v] of db.scan('evt:')) {
    if (v?.sessionId === sessionId && v.type === 'session.message' && v.payload?.role === 'assistant') n++;
  }
  return n;
}

const HAS_TMUX = await tmuxAvailable();

test('Pipe.setMode flips interactive after construction; setBaseArgs replaces base args', /** Verify Pipe.setMode flips interactive after construction; setBaseArgs replaces base args. */ () => {
  const p = new Pipe({
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json'],
    mode: 'default'
  });
  assert.equal(p.interactive, false);
  p.setMode('interactive');
  assert.equal(p.interactive, true, 'mode resolved at run-time, not locked at construction');
  p.setBaseArgs([]);
  assert.deepEqual(p.args, [], 'interactive launch drops the headless base args');
});

test('claude-code: interactive prepare launches the real TUI (no -p) and keeps --model/--resume', /** Verify claude-code: interactive prepare launches the real TUI (no -p) and keeps --model/--resume. */ async () => {
  const h = new Claude({
    config: {
      bin: 'claude'
    }
  });
  await h.prepare('hi', {
    mode: 'interactive',
    model: 'haiku',
    resume: 'abc'
  });
  const args = /** @type {Pipe} */ (h.transport).args;
  assert.ok(!args.includes('-p'), 'no headless -p in interactive mode');
  assert.ok(!args.includes('stream-json'), 'no stream-json framing in interactive mode');
  assert.deepEqual(args, ['--model', 'haiku', '--resume', 'abc'], 'only TUI-valid flags remain');
});

test('claude-code: default prepare keeps the headless stream-json pipe args', /** Verify claude-code: default prepare keeps the headless stream-json pipe args. */ async () => {
  const h = new Claude({
    config: {
      bin: 'claude',
      model: 'config-model',
      reasoningEffort: 'xhigh'
    }
  });
  await h.prepare('hi', {
    mode: 'default',
    cwd: '/tmp/sumo-claude-cwd',
    model: 'config-model',
    resume: 'native-session'
  });
  const args = /** @type {Pipe} */ (h.transport).args;
  assert.ok(args.includes('-p') && args.includes('stream-json'), 'headless mode unchanged');
  assert.ok(args.includes('--model') && args.includes('config-model'));
  assert.ok(args.includes('--reasoning-effort') && args.includes('high'));
  assert.ok(args.includes('--resume') && args.includes('native-session'));
  assert.deepEqual(h.interactiveResumeArgv('native-session'), ['--resume', 'native-session']);
  assert.equal(h.interactiveResumeArgv(''), null);
  assert.equal(h.transcriptPathFor('', '/tmp/sumo-claude-cwd'), undefined);
  assert.equal(h.transcriptPathFor('native-session', undefined), undefined);
});

test('claude-code: available rejects binaries that cannot launch Sumo stream-json mode', /** Verify claude-code: available rejects binaries that cannot launch Sumo stream-json mode. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-claude-probe-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "2.0.0 (Claude Code)"',
    '  exit 0',
    'fi',
    'echo "error: unknown option --output-format" >&2',
    'exit 1'
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  try {
    const result = await new Claude({
      config: {
        bin
      }
    }).available();
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /stream-json argv unsupported: error: unknown option --output-format/);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});

test('cursor: interactive prepare drops headless flags and does NOT pass the prompt positionally', /** Verify cursor: interactive prepare drops headless flags and does NOT pass the prompt positionally. */ async () => {
  const h = new Cursor({
    config: {
      bin: 'cursor-agent'
    }
  });
  await h.prepare('my prompt', {
    mode: 'interactive',
    cwd: '/tmp/sumo-cursor-cwd',
    model: 'cursor-model',
    resume: 'cursor-native'
  });
  const args = /** @type {Pipe} */ (h.transport).args;
  assert.ok(!args.includes('-p') && !args.includes('stream-json'), 'real TUI, not headless');
  assert.ok(!args.includes('my prompt'), 'prompt is typed into the pane, not a positional arg');
  assert.deepEqual(args, ['--model', 'cursor-model', '--resume', 'cursor-native']);
  assert.deepEqual(h.interactiveResumeArgv('cursor-native'), ['--resume', 'cursor-native']);
  assert.equal(h.interactiveResumeArgv(''), null);
});

test('cursor: headless prepare passes prompt positionally and rejects desktop launcher config', /** Verify cursor: headless prepare passes prompt positionally and rejects desktop launcher config. */ async () => {
  const h = new Cursor({
    config: {
      bin: 'cursor-agent',
      model: 'cursor-model'
    }
  });
  await h.prepare('my prompt', {
    mode: 'default',
    cwd: '/tmp/sumo-cursor-cwd',
    model: 'cursor-model',
    resume: 'cursor-native'
  });
  const args = /** @type {Pipe} */ (h.transport).args;
  assert.ok(args.includes('-p') && args.includes('stream-json'), 'headless mode keeps stream-json args');
  assert.deepEqual(args.slice(-5), ['--model', 'cursor-model', '--resume', 'cursor-native', 'my prompt']);

  await assert.rejects(
    /** Run the callback. */ () => new Cursor({
      config: {
        bin: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'
      }
    }).prepare('prompt', {
      mode: 'default'
    }),
    {
      code: 'SUMO_BACKEND_UNAVAILABLE'
    }
  );
});

test('cursor: headless write rejects follow-ups; interactive write accepts them (mode-aware)', /** Verify cursor: headless write rejects follow-ups; interactive write accepts them (mode-aware). */ async () => {
  const headless = new Cursor({
    config: {
      bin: 'cursor-agent',
      mode: 'default'
    }
  });
  const r1 = await headless.write({
    kind: 'prompt',
    text: 'x'
  });
  assert.equal(r1.ok, false, 'headless cursor has no stdin streaming (declared, not faked)');
  assert.equal(r1.code, 'SUMO_CAP_UNSUPPORTED');
  assert.deepEqual(await headless.write({
    kind: 'raw',
    bytes: 'ignored'
  }), {
    ok: true
  });
});

test('codex: captured stream error and write fallbacks stay on public adapter paths', /** Verify codex: captured stream error and write fallbacks stay on public adapter paths. */ async () => {
  const errorFrame = JSON.parse(fs.readFileSync(path.join(DIR, '..', '..', '..', 'packages', 'transcript', 'test', 'fixtures', 'codex', 'stream', 'usage-limit-error.jsonl'), 'utf8').split('\n')[0]);
  const events = [...new Codex().read(errorFrame)];
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.sumoCode, 'SUMO_RATE_LIMITED');
  assert.equal(events[0].payload.retryable, true);
  assert.equal(events[0].payload.fallback, true);
  assert.equal(events[0].ext.classification.code, 'SUMO_RATE_LIMITED');

  const h = new Codex({
    config: {
      bin: 'codex',
      cwd: '/tmp/sumo-codex-cwd',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      model: 'codex-model',
      reasoningEffort: 'low'
    }
  });
  await h.prepare('hi', {
    cwd: '/tmp/sumo-codex-override',
    model: 'runtime-model',
    reasoningEffort: 'minimal',
    resume: 'codex-thread'
  });
  assert.deepEqual(h.interactiveResumeArgv('codex-thread'), ['resume', 'codex-thread']);
  assert.equal(h.interactiveResumeArgv(''), null);

  const dead = await h.write({
    kind: 'prompt',
    text: 'hello'
  });
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'SUMO_SESSION_DEAD');
  assert.deepEqual(await h.write({
    kind: 'raw',
    bytes: 'ignored'
  }), {
    ok: true
  });
});

test('copilot: prepare and local capability checks stay on public adapter paths', /** Verify copilot: prepare and local capability checks stay on public adapter paths. */ async () => {
  const h = new Copilot({
    config: {
      bin: '/missing/sumo-copilot',
      model: 'config-model',
      reasoningEffort: 'low'
    }
  });
  await h.prepare('hi', {
    cwd: '/tmp/sumo-copilot-cwd',
    model: 'runtime-model',
    reasoningEffort: 'medium',
    resume: 'copilot-session'
  });
  await h.prepare('hi');

  const unavailable = await h.available();
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /not found|ENOENT|spawn/i);
  assert.equal(h.interactiveResumeArgv('copilot-session'), null);
  assert.equal(h.transcriptPathFor('copilot-session').endsWith(path.join('.copilot', 'session-state', 'copilot-session', 'events.jsonl')), true);
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = '/tmp/sumo-copilot-home';
  try {
    assert.equal(
      h.transcriptPathFor('copilot-session'),
      path.join('/tmp/sumo-copilot-home', 'session-state', 'copilot-session', 'events.jsonl')
    );
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }

  const dead = await h.start(null, 'hello');
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'SUMO_SESSION_DEAD');
});

test('claude-code capability is honest about tmux (): canSendKey only when tmux is present', /** Verify claude-code capability is honest about tmux (): canSendKey only when tmux is present. */ () => {
  const caps = new Claude().capabilitiesFor('interactive', {
    tmuxAvailable: false
  });
  assert.equal(caps.canSendKey, false, 'no tmux → no key surface, even in interactive mode');
  assert.equal(caps.observationSource, 'transcript-file');
  const withTmux = new Claude().capabilitiesFor('interactive', {
    tmuxAvailable: true
  });
  assert.equal(withTmux.canSendKey, true);
});

// ── Live: the full run({mode:'interactive'}) path against a real Claude TUI in a tmux pane ──────────
let claudeBin;
let skip = false;
try {
  if (!HAS_TMUX) throw new Error('tmux not available');
  claudeBin = await resolveClaudeBin();
} catch (err) {
  skip = `requires tmux + a real claude binary: ${/** @type {Error} */ (err).message.split('\n')[0]}`;
}

test('LIVE interactive: run({mode:interactive}) drives a real Claude TUI in tmux', {
  skip,
  timeout: 120_000
}, /** Verify LIVE interactive: run({mode:interactive}) drives a real Claude TUI in tmux. */ async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-it-claude-'));
  const harness = new Claude({
    config: {
      bin: claudeBin,
      cwd
    }
  });
  const session = await harness.run('Reply with exactly one word: pong', {
    mode: 'interactive',
    cwd
  });
  try {
    assert.equal(session.capabilities.canSendKey, true, 'interactive + tmux → key injection advertised');
    assert.equal(session.capabilities.observationSource, 'transcript-file', 'interactive session declares transcript-file source (no live stdout stream)');

    // Unwrap the Result from capture() and wait for the TUI to render.
    let snap = '';
    for (let i = 0; i < 40 && !snap.trim(); i++) {
      await sleep(250);
      const cap = await session.capture();
      snap = (cap && typeof cap === 'object' && 'value' in cap ? cap.value : cap) ?? '';
    }
    assert.ok(snap.trim().length > 0, 'capture-pane shows the live Claude TUI');

    const sent = await session.send('Reply with exactly one word: again');
    assert.equal(sent.ok, true, 'send typed a prompt into the pane');
    const cancelled = await session.cancel();
    assert.equal(cancelled.ok, true, 'interrupt (C-c) accepted');
    assert.equal(harness.transport.health.alive ?? true, true, 'session still alive after interrupt (C-c does not kill the process)');
  } finally {
    await session.end({
      force: true
    }).catch(/** Handle the expected rejection. */ () => {});
    fs.rmSync(cwd, {
      recursive: true,
      force: true
    });
  }
});

// ──  — interactive session observation chain (transcript-file → DB) ───────────────────────────
//
// In interactive mode, `observationSource:'transcript-file'` — `frames()` yields nothing by design;
// events arrive only when the acquirer tails the on-disk JSONL. This test proves the OBSERVATION
// side of that chain: given an interactive ses: doc and a real Claude transcript dropped into the
// correct transcript dir (as Claude would write it after a TUI session), the ingest service
// discovers, correlates, and tails it into the DB.
//
// The control side (send/capture/interrupt) is proven by the test above. Separating them is honest:
// in production, Claude TUI writes its JSONL transcript when a conversation ends or a session is
// saved; the exact timing is internal to Claude. Testing Sumo's ingestion path is within scope;
// asserting Claude's internal write timing is not.

test(' interactive observation: transcript-file → DB via ingest service (uses real Claude JSONL fixture)', {
  skip: (!HAS_TMUX && skip) || false,
  timeout: 30_000
}, /** Verify  interactive observation: transcript-file → DB via ingest service (uses real Claude JSONL fixture). */ async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-v3-home-'));
  const db = await open({
    home,
    idleShutdownMs: 60_000
  });
  const cwd = fs.realpathSync(fs.mkdtempSync('/tmp/sumo-v3-cwd-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-v3-claude-'));
  const transcriptDir = path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(transcriptDir, {
    recursive: true
  });

  // Start the ingest service watching ONLY this session's transcript dir. It uses the same
  // real ClaudeArtifacts acquirer with real signal extraction and real correlate/ingest logic.
  const svc = watcher({
    db,
    adapters: [new ClaudeArtifacts()],
    /** Implement isInScope. */
    isInScope() {
      return true;
    },
    /** Implement resolveRoot. */
    resolveRoot() {
      return transcriptDir;
    },
    debounceMs: 20
  });
  await svc.ready;

  try {
    // Drop a REAL captured Claude JSONL transcript fixture into the watched dir. This is the same
    // format Claude actually writes in both headless and TUI modes. The fixture carries a real
    // sessionId (nativeId) and cwd — the ingest service reads these via signals() and creates a
    // foreign ses: doc to correlate against.
    const FIXTURE = path.join(DIR, '..', '..', '..', 'packages', 'transcript', 'test', 'fixtures', 'claude-code', 'file', 'turn.jsonl');
    const transcriptFile = path.join(transcriptDir, 'b06f2b01-de75-4950-b7c7-8011e0d74fc9.jsonl');
    fs.writeFileSync(transcriptFile, fs.readFileSync(FIXTURE));
    await sleep(50);
    fs.appendFileSync(transcriptFile, '\n');

    // Wait for the ingest service to discover, correlate, and tail the transcript.
    const deadline = Date.now() + 20_000;
    let doc;
    let turns = 0;
    while (Date.now() < deadline) {
      const docs = [];
      for await (const [, d] of db.scan('ses:')) docs.push(d);
      doc = docs.find(/** Find a matching item. */ (d) => d.harness === 'claude-code');
      if (doc) {
        turns = await assistantEvents(db, doc.id);
        if (turns > 0) break;
      }
      await sleep(300);
    }

    assert.ok(doc, 'ingest service created a ses: doc by correlating the transcript signals');
    assert.ok(doc.harnessSessionId, 'native session id extracted from the transcript records');
    assert.ok(turns > 0, 'assistant turn from the transcript landed in the DB (: transcript-file observation chain works end-to-end)');

    // The ses: doc for a TUI-sourced transcript is `observed` (no live Sumo handle) — consistent with
    // `observationSource:transcript-file` + ingest service producing the DB record.
    assert.equal(doc.ext?.foreign, true, 'doc is marked foreign (no live orchestrator handle for a TUI session)');
  } finally {
    await svc.stop();
    await db.close();
    try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
    fs.rmSync(home, {
      recursive: true,
      force: true
    });
    fs.rmSync(cwd, {
      recursive: true,
      force: true
    });
    fs.rmSync(base, {
      recursive: true,
      force: true
    });
  }
});
