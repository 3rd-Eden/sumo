/**
 * Live conformance against the ACTUAL harnesses — the drift detector. Runs by default (§3f/§5).
 *
 * Committed fixtures are real but frozen snapshots: they catch regressions in OUR code, not changes in
 * a harness's output format. This suite re-runs the real CLIs / app-server and feeds their live output
 * through the parser, so if a harness changes its transcript format in a way the parser can't handle,
 * THIS breaks (loudly) — instead of the silent staleness a frozen fixture (or a mock) would hide.
 *
 * It spawns the installed CLIs and makes real model calls (cost + network + nondeterminism), and needs
 * the harnesses authenticated on this machine. When a required binary is absent it skips with a clear
 * reason — never a mock fallback (§5).
 *
 * "Handles" means, per harness: every emitted event validates against `EventSchema` (so an
 * unrecognized record became a lossless `session.raw:*` passthrough, never a throw or a drop) AND the
 * core types we claim to normalize are present (`session.started` + an assistant `session.message`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adapters, isResult, EventSchema } from '../src/index.mjs';
import { assertClaudeBin, assertAvailable, captureCopilotHarnessSession, liveUnavailableCodeFromText } from '../../harness/test/_live.mjs';
import { Cursor, Codex, Copilot } from '../../harness/src/index.mjs';

const PROMPT = 'Reply with exactly: HELLO';
const TIMEOUT_MS = 120_000;

/** Spawn a command in a throwaway cwd, collect stdout, return parsed JSONL lines. */
function runCli(cmd, args, { timeoutMs = 120000 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-live-'));
  return new Promise(/** Run the callback. */ (resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(/** Run the timer callback. */ () => { child.kill('SIGTERM'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', /** Run the callback. */ (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', /** Run the callback. */ () => {
      clearTimeout(timer);
      resolve(out.split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    });
  });
}

/** Feed live records through a parser entry point; returns all validated events (validation throws on drift). */
function normalizeAll(harness, entry, records) {
  const P = new adapters[harness]();
  const events = [];
  for (const rec of records) {
    const r = P[entry](rec);
    if (isResult(r)) continue;
    for (const e of r) events.push(EventSchema.parse(e)); // re-validate: a format change that breaks normalization fails here
  }
  return events;
}

/** Implement assertCore. */ function assertCore(events, label) {
  assert.ok(events.length > 0, `${label}: produced no events (harness output format may have changed)`);
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.started'), `${label}: no session.started`);
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'), `${label}: no assistant session.message`);
}

const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/** Implement skipIfLiveUnavailable. */ function skipIfLiveUnavailable(t, events, label) {
  const event = events.find(/** Find a matching item. */ (e) => LIVE_UNAVAILABLE.has(e.payload?.sumoCode ?? e.ext?.classification?.code));
  const code = event?.payload?.sumoCode ?? event?.ext?.classification?.code;
  if (!code) return false;
  t.skip(`${label} live prerequisite unavailable: ${code}`);
  return true;
}

test('LIVE claude-code: parser handles current stream-json output', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE claude-code: parser handles current stream-json output. */ async (t) => {
  const bin = await assertClaudeBin(t);
  if (!bin) return;
  const records = await runCli(bin, ['-p', '--output-format', 'stream-json', '--verbose', PROMPT]);
  assertCore(normalizeAll('claude-code', 'stream', records), 'claude live stream');
});

test('LIVE cursor: parser handles current stream-json output', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE cursor: parser handles current stream-json output. */ async (t) => {
  const cfg = await assertAvailable(Cursor, process.env.SUMO_CURSOR_BIN ? { bin: process.env.SUMO_CURSOR_BIN } : {}, t);
  if (!cfg) return;
  const bin = cfg.bin ?? 'cursor-agent';
  const records = await runCli(bin, ['-p', '--force', '--output-format', 'stream-json', PROMPT]);
  assertCore(normalizeAll('cursor', 'stream', records), 'cursor live stream');
});

test('LIVE codex: parser handles current app-server notifications', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE codex: parser handles current app-server notifications. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;
  const bin = cfg.bin ?? 'codex';
  const captured = await captureCodexAppServer(PROMPT, bin);
  const events = normalizeAll('codex', 'stream', captured.records);
  if (skipIfLiveUnavailable(t, events, 'codex live parser')) return;
  const unavailableCode = liveUnavailableCodeFromText(captured.stderr);
  if (unavailableCode && !events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant')) {
    t.skip(`codex live parser prerequisite unavailable: ${unavailableCode}`);
    return;
  }
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.started'), 'codex live: no session.started');
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'), 'codex live: no assistant session.message');
  assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.final-answer'), 'codex live: no session.final-answer signal');
});

test('LIVE copilot: parser handles current server-session frames captured through the harness path', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: parser handles current server-session frames captured through the harness path. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  let captured;
  try {
    captured = await captureCopilotHarnessSession(PROMPT, {
      ...cfg,
      /** Implement fileReady. */ fileReady(records) {
        return records.some(/** Test whether an item matches. */ (event) => event.type === 'assistant.message' || event.type === 'session.error');
      }
    });
    const events = normalizeAll('copilot', 'stream', captured.rawEvents);
    if (skipIfLiveUnavailable(t, events, 'copilot live parser')) return;
    assert.ok(events.length > 0, 'copilot live harness stream: produced no events');
    assert.ok(
      events.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'),
      'copilot live harness stream: no assistant session.message'
    );
    assert.ok(captured.doc.harnessSessionId, 'copilot native session id recorded from the SDK session');
    assert.ok(captured.doc.transcriptPath, 'copilot transcript path recorded from the SDK session');
  } finally {
    await captured?.cleanup?.();
  }
});

test('LIVE copilot: parser handles current session-state events.jsonl', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: parser handles current session-state events.jsonl. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  let captured;
  try {
    captured = await captureCopilotHarnessSession(PROMPT, {
      ...cfg,
      /** Implement fileReady. */ fileReady(records) {
        return records.some(/** Test whether an item matches. */ (event) => event.type === 'assistant.message' || event.type === 'session.error');
      }
    });
    const events = normalizeAll('copilot', 'file', captured.fileEvents);
    if (skipIfLiveUnavailable(t, events, 'copilot live file parser')) return;
    assertCore(events, 'copilot live file stream');
  } finally {
    await captured?.cleanup?.();
  }
});

/** Drive `codex app-server` through one turn and return the JSON-RPC notifications it emits. */
function captureCodexAppServer(prompt, bin = 'codex') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-live-codex-'));
  return new Promise(/** Run the callback. */ (resolve, reject) => {
    const child = spawn(bin, ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const received = [];
    let buf = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map();
    let done = false;
    /** Implement send. */ function send(method, params) { const id = nextId++; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'); return id; }
    /** Implement request. */ function request(method, params) {
      return new Promise(/** Run the callback. */ (res, rej) => {
        const id = send(method, params);
        const timer = setTimeout(/** Run the timer callback. */ () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          rej(new Error(`${method} timeout`));
        }, 40000);
        pending.set(id, /** Run the callback. */ (value) => {
          clearTimeout(timer);
          res(value);
        });
      });
    }
    const overall = setTimeout(/** Run the timer callback. */ () => finish(), 90000);
    /** Implement finish. */ function finish() {
      if (done) return;
      done = true;
      clearTimeout(overall);
      for (const settle of pending.values()) settle({ ok: false });
      pending.clear();
      const payload = received.filter(/** Select matching items. */ (m) => m.method);
      child.once('close', /** Run the callback. */ () => {
        fs.rmSync(cwd, { recursive: true, force: true });
        resolve({ records: payload, stderr });
      });
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(/** Run the timer callback. */ () => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref?.();
    }
    child.stdout.on('data', /** Run the callback. */ (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        received.push(m);
        if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
        if (m.method === 'turn/completed') finish();
      }
    });
    child.stderr.on('data', /** Run the callback. */ (d) => { stderr += d.toString(); });
    child.on('error', reject);
    (/** Run the callback. */ async () => {
      try {
        await request('initialize', { clientInfo: { name: 'sumo-live', version: '0' } });
        const s = await request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' });
        const threadId = s?.result?.thread?.id;
        if (!threadId) throw new Error('no thread id');
        await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
      } catch (e) { reject(e); }
    })();
  });
}
