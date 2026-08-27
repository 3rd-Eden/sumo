/**
 * Shared live-harness test helper: resolve REAL CLI binaries and locate the artifacts they write.
 * There are NO mock transports anywhere (CONVENTIONS §3f/§5) — tests spawn the real subprocess.
 * Callers that pass a node:test context skip with a clear reason when an external prerequisite is
 * missing; callers without one still fail loudly.
 *
 * @module sumo/harness/test/_live
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { open, key } from 'sumo/db';
import { Claude, Copilot } from '../src/index.mjs';
import { classify } from '../src/base/classify.mjs';
import { whichSync } from '../src/base/probe.mjs';
import { resolveCopilotRuntime } from '../src/transport/CopilotServer.mjs';

const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/**
 * Classify real live-harness stderr/output as an external prerequisite failure when possible.
 * @param {string} text
 * @returns {string}
 */
export function liveUnavailableCodeFromText(text) {
  const value = String(text ?? '');
  for (const code of LIVE_UNAVAILABLE) {
    if (value.includes(code)) return code;
  }
  const code = classify({ stderr: value }).code;
  return LIVE_UNAVAILABLE.has(code) ? code : '';
}

/**
 * @typedef {object} LiveTestContext
 * @property {(reason: string) => void} skip Marks the current node:test case as skipped.
 */

/**
 * @typedef {object} AvailabilityProbe
 * @property {'available'|'unavailable'|'unknown'} status Adapter availability result.
 * @property {string} [reason] Human-readable unavailability reason.
 * @property {string} [bin] Resolved binary hint returned by the adapter.
 * @property {string} [model] Model hint returned by the adapter.
 */

/**
 * Harness adapter constructor shape used by live tests that probe real CLIs.
 * @typedef {new (opts: object) => { id: string, available: () => Promise<AvailabilityProbe> }} LiveHarnessConstructor
 */

/**
 * @typedef {object} SelectedLiveHarness
 * @property {string} id Selected harness id.
 * @property {LiveHarnessConstructor} HarnessClass Adapter constructor for the selected harness.
 * @property {object} config Config to pass when constructing the harness in the test.
 */

/**
 * Resolve a real `claude` binary through the adapter's production availability probe, trying:
 * `$SUMO_CLAUDE_BIN`, `$CLAUDE_CODE_EXECPATH` (the real binary Claude Code itself records), then PATH
 * `claude`. Throws LOUDLY when none works — never mocks, never silently skips (§5).
 * @returns {Promise<string>} the usable binary path/name
 */
export async function resolveClaudeBin() {
  const candidates = [process.env.SUMO_CLAUDE_BIN, process.env.CLAUDE_CODE_EXECPATH, 'claude'].filter(Boolean);
  const reasons = [];
  for (const bin of candidates) {
    try {
      const config = await assertAvailable(Claude, { bin });
      return /** @type {{ bin?: string }} */ (config).bin ?? bin;
    } catch (err) {
      reasons.push(`${bin}: ${/** @type {Error} */ (err).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    'requires a real `claude` binary accepted by Claude.available(). ' +
    `None of [${candidates.join(', ')}] worked: ${reasons.join('; ')}. ` +
    'Set SUMO_CLAUDE_BIN to the real binary (e.g. $CLAUDE_CODE_EXECPATH), or install `claude`.'
  );
}

/**
 * Resolve a live Claude binary for a test, skipping when the environment cannot provide one.
 * @param {LiveTestContext} [t] Optional node:test context used to skip instead of throw.
 * @returns {Promise<string|null>} Usable binary path/name, or null after marking the test skipped.
 */
export async function assertClaudeBin(t) {
  try {
    return await resolveClaudeBin();
  } catch (err) {
    const reason = `claude-code not available for live tests: ${/** @type {Error} */ (err).message}`;
    if (t) { t.skip(reason); return null; }
    throw err;
  }
}

/**
 * Resolve a binary by `$<ENV>` override or PATH presence. Use for external tools that are not harness
 * adapters themselves. With a test context, missing dependencies skip instead of failing the suite.
 * @param {string} name Binary name to find on PATH.
 * @param {string} [env] Optional env var holding an explicit path override.
 * @param {LiveTestContext} [t] Optional node:test context used to skip instead of throw.
 * @returns {string|null} Resolved binary name/path, or null after marking the test skipped.
 */
export function requireBin(name, env, t) {
  const override = env ? process.env[env] : undefined;
  if (override) return override;
  if (whichSync(name)) {
    return name;
  }
  const reason = `requires the \`${name}\` binary on PATH${env ? ` (or set $${env})` : ''}; it is not installed in this environment — install it or run elsewhere (this test never mocks it).`;
  if (t) { t.skip(reason); return null; }
  throw new Error(reason);
}

/**
 * Locate the on-disk transcript `claude` wrote for a session by scanning the Claude config dir's
 * `projects/` for `<sessionId>.jsonl` (the project dir is the cwd path-encoded; we search rather than
 * recompute it). Honors `CLAUDE_CONFIG_DIR` so it stays consistent with the harness path derivation.
 * @param {string} sessionId
 * @returns {string|null} absolute path, or null if not found
 */
export function findTranscript(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const target = `${sessionId}.jsonl`;
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = walk(full); if (hit) return hit; }
      else if (e.name === target) return full;
    }
    return null;
  }
  return walk(root);
}

/** Read + parse a JSONL transcript file into decoded records. */
export function readJsonl(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => JSON.parse(l)); }

/**
 * Poll for a file to exist.
 * @param {string} file
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function waitForPath(file, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    await new Promise(/** Run the callback. */ (resolve) => setTimeout(resolve, 100));
  }
  return fs.existsSync(file);
}

/**
 * Check a harness adapter is available for live testing by calling its `available()` method.
 * Returns a config object (merged from the caller's config and any hints from `available()`)
 * that should be used to instantiate the harness for the test.
 * When unavailable: calls `t.skip(reason)` if a test context is provided, otherwise throws.
 * §3f/§5: never silently skips — the reason is always surfaced.
 * @param {LiveHarnessConstructor} HarnessClass Adapter constructor to probe.
 * @param {object} [config] Base config, such as an explicit bin override from env.
 * @param {LiveTestContext} [t] Optional node:test context used to skip instead of throw.
 * @returns {Promise<object|null>} Merged config to pass to the harness constructor, or null after skip.
 */
export async function assertAvailable(HarnessClass, config = {}, t) {
  const harness = new HarnessClass({ config });
  const explicitCodexLive = process.env.SUMO_CODEX_LIVE === '1' || process.env.SUMO_CODEX_BIN || (config.bin && config.bin !== 'codex');
  if (harness.id === 'codex' && !explicitCodexLive) {
    const reason = 'codex live tests require SUMO_CODEX_BIN, an explicit bin, or SUMO_CODEX_LIVE=1; default coverage does not stress live Codex';
    if (t) { t.skip(reason); return null; }
    throw new Error(reason);
  }
  const result = await harness.available();
  if (result.status === 'unavailable') {
    const reason = `${harness.id} not available for live tests: ${result.reason}`;
    if (t) { t.skip(reason); return null; }
    throw new Error(reason);
  }
  // Merge availability hints (bin, model) into config so the test uses the recommended tier.
  return {
    ...(result.bin ? { bin: result.bin } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...config // explicit caller overrides win
  };
}

/**
 * Resolve the persisted Copilot session-state paths for a native session id.
 * @param {string} sessionId
 * @param {string} [baseDirectory]
 */
export function copilotSessionPaths(sessionId, baseDirectory = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) {
  const dir = path.join(baseDirectory, 'session-state', sessionId);
  return {
    dir,
    events: path.join(dir, 'events.jsonl'),
    workspace: path.join(dir, 'workspace.yaml'),
    plan: path.join(dir, 'plan.md')
  };
}

/**
 * Open a real SDK client against the system Copilot runtime.
 * @param {{ bin?: string, cwd?: string, baseDirectory?: string }} [config]
 */
async function openCopilotClient(config = {}) {
  const runtimePath = resolveCopilotRuntime(config.bin ?? 'copilot');
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: runtimePath }),
    ...(config.cwd ? { workingDirectory: config.cwd } : {}),
    ...(config.baseDirectory ? { baseDirectory: config.baseDirectory } : {})
  });
  await client.start();
  return client;
}

/** Spin up a real daemon on a temp dir. */
async function openTempDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copilot-live-db-'));
  const db = await open({ home, idleShutdownMs: 1000 });
  return {
    db,
    home,
    /** Implement cleanup. */ async cleanup() {
      await db.close();
      try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/**
 * Poll until `probe()` returns a truthy value, then return it.
 * @template T
 * @param {() => Promise<T | null | undefined> | T | null | undefined} probe
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
async function waitForValue(probe, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await new Promise(/** Run the callback. */ (resolve) => setTimeout(resolve, 100));
  }
  const last = await probe();
  if (last) return last;
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Capture a real Copilot session's raw SDK events plus persisted session-state location.
 * @param {string} prompt
 * @param {{ bin?: string, cwd?: string, baseDirectory?: string, model?: string, reasoningEffort?: string, timeoutMs?: number, stopWhen?: (event: any, events: any[]) => boolean, fileReady?: (records: any[], ctx: { doc: any, liveEvents: any[], rawEvents: any[] }) => boolean }} [config]
 */
export async function captureCopilotHarnessSession(prompt, config = {}) {
  const timeoutMs = config.timeoutMs ?? 120_000;
  const ctx = await openTempDb();
  const ownCwd = !config.cwd;
  const cwd = config.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-copilot-live-'));
  const rawEvents = [];
  let session = null;
  let nativeId = '';
  try {
    const liveEvents = [];
    const harness = new Copilot({
      db: ctx.db,
      config: {
        ...config,
        cwd,
        /** Implement onEvent. */ onEvent(event) { rawEvents.push(event); }
      }
    });
    session = await harness.run(prompt, {
      cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {})
    });

    const stopWhen = config.stopWhen ?? (/** Run the callback. */ (event) =>
      (event.type === 'session.message' && event.payload?.role === 'assistant') ||
      LIVE_UNAVAILABLE.has(event.ext?.classification?.code ?? event.payload?.sumoCode)
    );
    const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), timeoutMs);
    try {
      for await (const event of session.join()) {
        liveEvents.push(event);
        if (stopWhen(event, liveEvents)) break;
        if (event.type === 'session.ended' || event.type === 'session.dead' || event.type === 'session.rapid-death') break;
      }
    } finally {
      clearTimeout(deadline);
      await session.end().catch(/** Handle the expected rejection. */ () => {});
      await session.done().catch(/** Handle the expected rejection. */ () => {});
    }

    const doc = await waitForValue(
      /** Run the callback. */ async () => {
        const value = await ctx.db.get(key(session.id));
        return value?.harnessSessionId && value?.transcriptPath ? value : null;
      },
      { timeoutMs, label: 'copilot session doc' }
    );
    nativeId = doc.harnessSessionId;
    await waitForPath(doc.transcriptPath, timeoutMs);
    const fileEvents = await waitForValue(
      /** Run the callback. */ async () => {
        const records = readJsonl(doc.transcriptPath);
        return (config.fileReady ? config.fileReady(records, { doc, liveEvents, rawEvents }) : records.length > 0) ? records : null;
      },
      { timeoutMs, label: 'copilot transcript contents' }
    );
    return {
      db: ctx.db,
      liveEvents,
      rawEvents,
      fileEvents,
      sessionId: session.id,
      nativeId,
      cwd,
      doc,
      transcriptPath: doc.transcriptPath,
      /** Implement cleanup. */ async cleanup() {
        if (nativeId) await deleteCopilotSession(nativeId, config).catch(/** Handle the expected rejection. */ () => {});
        await ctx.cleanup();
        if (ownCwd) fs.rmSync(cwd, { recursive: true, force: true });
      }
    };
  } catch (err) {
    if (nativeId) await deleteCopilotSession(nativeId, config).catch(/** Handle the expected rejection. */ () => {});
    try { await ctx.cleanup(); } catch {}
    if (ownCwd) fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  } finally {
    if (!session) {
      await ctx.cleanup();
      if (ownCwd) fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/**
 * Delete a Copilot session and its persisted artifacts.
 * @param {string} sessionId
 * @param {{ bin?: string, cwd?: string, baseDirectory?: string }} [config]
 */
export async function deleteCopilotSession(sessionId, config = {}) {
  const client = await openCopilotClient(config);
  try {
    await client.deleteSession(sessionId);
  } finally {
    try { await client.stop(); } catch {}
  }
}

/**
 * Select the first available live harness from a list of adapter classes.
 * @param {{ candidates: LiveHarnessConstructor[], configs?: Record<string, object>, t?: LiveTestContext }} opts Selection options.
 * @returns {Promise<SelectedLiveHarness|null>} Selected harness, or null after marking the test skipped.
 */
export async function selectAvailableHarness({ candidates, configs = {}, t }) {
  const reasons = [];
  for (const HarnessClass of candidates) {
    const probeHarness = new HarnessClass({});
    const baseConfig = configs[probeHarness.id] ?? {};
    try {
      const config = await assertAvailable(HarnessClass, baseConfig);
      return { id: probeHarness.id, HarnessClass, config };
    } catch (err) {
      reasons.push(/** @type {Error} */ (err).message);
    }
  }
  const reason = `no live harness available: ${reasons.join('; ')}`;
  if (t) { t.skip(reason); return null; }
  throw new Error(reason);
}
