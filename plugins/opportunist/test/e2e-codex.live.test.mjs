/**
 * Live opportunist journey: a real Codex parent works in a temp project with an existing failing
 * test, opportunist triages the lingering finding after the parent turn, and a separate repair
 * session fixes it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { install } from 'sumo/cli';
import { Codex, codex as codexHarness } from 'sumo/harness';
import { Orchestrator } from 'sumo/orchestrator';
import { plugin } from 'sumo/plugin';
import { waitUntil } from 'sumo/util';
import { allEvents, closeTempDb, openTempDb } from 'sumo/util/testing';

import { assertAvailable } from '../../../packages/harness/test/_live.mjs';
import opportunist from '../index.mjs';

const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/**
 * Allow Codex app-server approval requests in the isolated temp project.
 *
 * @param {{ modify: (name: string, fn: () => Record<string, unknown>) => void }} sumo - Sumo facade.
 * @returns {void} Registers the approval decision policy.
 */
function allowApprovals(sumo) {
  sumo.modify('approval', () => ({ action: 'allow' }));
}

allowApprovals.sumo = { name: 'opportunist-e2e-approval-policy' };

/**
 * Capture rendered CLI output.
 *
 * @returns {{ out: (line: string) => number, text: () => string }} Output sink for install.
 */
function sink() {
  const lines = [];
  return {
    /** Record one rendered line. */
    out(line) { return lines.push(line); },
    /** Join captured output for assertions. */
    text() { return lines.join('\n'); }
  };
}

/**
 * Build the environment used by the live Codex process.
 *
 * @returns {NodeJS.ProcessEnv} Environment without node:test child-process recursion markers.
 */
function liveEnv() {
  const env = { ...process.env, SUMO_INGEST: '0' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Create the temporary project used by the live journey.
 *
 * @param {string} root - Directory to populate.
 * @returns {void} Writes package, source, tests, and Sumo config files.
 */
function writeProject(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    type: 'module',
    scripts: { test: 'env -u NODE_TEST_CONTEXT node --test' }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'src', 'legacy.mjs'), "export function meaning() {\n  return 41;\n}\n");
  fs.writeFileSync(path.join(root, 'test', 'legacy.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { meaning } from '../src/legacy.mjs';",
    '',
    "test('legacy arithmetic behavior', () => {",
    '  assert.equal(meaning(), 42);',
    '});',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'sumo.yml'), [
    'root: true',
    'use:',
    `  - ${JSON.stringify(path.resolve('plugins/opportunist/index.mjs'))}`,
    'plugins:',
    '  opportunist:',
    '    harness: codex',
    ''
  ].join('\n'));
}

/**
 * Build the parent-agent prompt for the temporary project.
 *
 * @returns {string} Prompt sent to the real parent agent.
 */
function parentPrompt() {
  return [
    'In this temporary Node project, make one small feature change.',
    '',
    'Tasks:',
    '1. Add src/greeting.mjs exporting function greeting(name) that returns `Hello, ${name}!`.',
    "2. Add test/greeting.test.mjs using node:test and node:assert/strict to verify greeting('Sumo') === 'Hello, Sumo!'.",
    '3. Run npm test.',
    'After running npm test once, finish with a concise summary of the result. Do not perform follow-up debugging in this parent task.',
    ''
  ].join('\n');
}

/**
 * Run the temporary project's test command outside the live parent or repair agents.
 *
 * @param {string} projectDir - Temporary project root.
 * @returns {{ status: number|null, stdout: string, stderr: string }} Completed process result.
 */
function runProjectTests(projectDir) {
  const result = spawnSync('npm', ['test'], {
    cwd: projectDir,
    env: liveEnv(),
    encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Decide whether a spawn failure should skip this live test.
 *
 * @param {{ ok: boolean, code?: string, reason?: string }} result - Spawn result from orchestrator.
 * @param {import('node:test').TestContext} t - Test context used to mark skips.
 * @returns {boolean} True when the caller should return.
 */
function skipUnavailableSpawn(result, t) {
  if (result.ok) return false;
  const reason = String(result.reason ?? '');
  if (LIVE_UNAVAILABLE.has(result.code) || (result.code === 'SUMO_NO_HARNESS' && /(login|auth|rate|budget|backend|overload|unavailable|exit null)/i.test(reason))) {
    t.skip(`codex opportunist live prerequisite unavailable: ${result.code}${reason ? ` - ${reason}` : ''}`);
    return true;
  }
  return false;
}

/**
 * Wait for a finding, or report a live-backend availability failure as a skipped test.
 *
 * @param {ReturnType<typeof plugin>} runtime - Runtime carrying opportunist commands.
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string} parentSessionId - Parent session id to filter by.
 * @param {import('node:test').TestContext} t - Test context used to mark skips.
 * @returns {Promise<Record<string, unknown>|null>} Stored finding, or null after skip.
 */
async function waitForFindingOrLiveSkip(runtime, db, parentSessionId, t) {
  return waitUntil(async () => {
    const unavailable = await liveUnavailableCode(db, [parentSessionId]);
    if (unavailable) {
      t.skip(`codex opportunist live prerequisite unavailable after spawn: ${unavailable}`);
      return /** @type {Record<string, unknown>} */ ({ skipped: true });
    }
    const result = await runtime.invoke('opportunist-findings', { sessionId: parentSessionId });
    assert.equal(result.ok, true);
    return result.value.findings[0] ?? false;
  }, { timeoutMs: 180_000, intervalMs: 1000 }).then((finding) => finding.skipped ? null : finding);
}

/**
 * Tail the daemon event log until the parent session proves that live harness output is flowing.
 *
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string} parentSessionId - Parent session id to filter by.
 * @returns {Promise<{ eventCount: number, toolCount: number, textCount: number }>} Tail evidence.
 */
async function waitForDbTailEvidence(db, parentSessionId) {
  return waitUntil(async () => {
    const events = (await allEvents(db)).filter((event) => event.sessionId === parentSessionId);
    const toolCount = events.filter((event) => event.type === 'session.tool').length;
    const textCount = events.filter((event) => event.type === 'session.message' || event.type === 'session.reasoning').length;
    return events.length >= 3 && (toolCount > 0 || textCount > 0) ? { eventCount: events.length, toolCount, textCount } : false;
  }, { timeoutMs: 120_000, intervalMs: 1000 });
}

/**
 * Wait for the spawned repair session to finish with a parsed resolution.
 *
 * @param {ReturnType<typeof plugin>} runtime - Runtime carrying opportunist commands.
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string} parentSessionId - Parent session id to filter by.
 * @param {string} findingId - Finding id to resolve.
 * @param {string} triageSessionId - Spawned triage session id.
 * @param {string} repairSessionId - Spawned repair session id.
 * @param {import('node:test').TestContext} t - Test context used to mark live skips.
 * @returns {Promise<Record<string, unknown>|null>} Resolved finding, or null after skip.
 */
async function waitForRepairResolved(runtime, db, parentSessionId, findingId, triageSessionId, repairSessionId, t) {
  return waitUntil(async () => {
    const unavailable = await liveUnavailableCode(db, [parentSessionId, triageSessionId, repairSessionId]);
    if (unavailable) {
      t.skip(`codex opportunist live prerequisite unavailable during repair: ${unavailable}`);
      return /** @type {Record<string, unknown>} */ ({ skipped: true });
    }
    const result = await runtime.invoke('opportunist-findings', { sessionId: parentSessionId });
    assert.equal(result.ok, true);
    const current = result.value.findings.find((item) => item.id === findingId);
    if (current?.state === 'resolved' && current.repairSessionId === repairSessionId) return current;
    return false;
  }, { timeoutMs: 300_000, intervalMs: 1000 }).then((finding) => finding.skipped ? null : finding);
}

/**
 * Wait for a triage child-session final response containing the required decision block.
 *
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string} triageSessionId - Spawned triage session id.
 * @returns {Promise<Record<string, unknown>>} Final triage assistant event.
 */
async function waitForTriageDecisionBlock(db, triageSessionId) {
  return waitUntil(async () => {
    const events = (await allEvents(db)).filter((event) => event.sessionId === triageSessionId);
    return events.find((event) =>
      (event.type === 'session.message' || event.type === 'session.final-answer') &&
      /OPPORTUNIST_TRIAGE[\s\S]*"action"\s*:\s*"repair"[\s\S]*END_OPPORTUNIST_TRIAGE/i.test(String(event.payload?.text ?? ''))
    ) ?? false;
  }, { timeoutMs: 300_000, intervalMs: 1000 });
}

/**
 * Wait for a child-session final response containing the required opportunist result block.
 *
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string} repairSessionId - Spawned repair session id.
 * @returns {Promise<Record<string, unknown>>} Final child assistant event.
 */
async function waitForChildResultBlock(db, repairSessionId) {
  return waitUntil(async () => {
    const events = (await allEvents(db)).filter((event) => event.sessionId === repairSessionId);
    return events.find((event) =>
      (event.type === 'session.message' || event.type === 'session.final-answer') &&
      /OPPORTUNIST_RESULT[\s\S]*status:\s*fixed[\s\S]*END_OPPORTUNIST_RESULT/i.test(String(event.payload?.text ?? ''))
    ) ?? false;
  }, { timeoutMs: 300_000, intervalMs: 1000 });
}

/**
 * Check the event log for classified live prerequisite failures.
 *
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {string[]} sessionIds - Sessions to inspect.
 * @returns {Promise<string|undefined>} First live-unavailable code found.
 */
async function liveUnavailableCode(db, sessionIds) {
  for (const event of await allEvents(db)) {
    if (!sessionIds.includes(event.sessionId)) continue;
    const code = event.ext?.classification?.code ?? event.payload?.sumoCode;
    if (LIVE_UNAVAILABLE.has(code)) return code;
  }
  return undefined;
}

/**
 * Summarize live event-log state when the journey does not reach the expected opportunist finding.
 *
 * @param {import('sumo/db').SumoDb} db - Isolated daemon DB.
 * @param {ReturnType<typeof plugin>} runtime - Runtime carrying opportunist commands.
 * @param {string|undefined} parentSessionId - Parent session id, if spawn succeeded.
 * @returns {Promise<string>} Diagnostic text for assertion failures.
 */
async function diagnostics(db, runtime, parentSessionId) {
  const events = await allEvents(db);
  const triageSessionIds = new Set(events
    .filter((event) => typeof event.payload?.triageSessionId === 'string')
    .map((event) => event.payload.triageSessionId));
  const repairSessionIds = new Set(events
    .filter((event) => typeof event.payload?.repairSessionId === 'string')
    .map((event) => event.payload.repairSessionId));
  const related = parentSessionId ? events.filter((event) =>
    event.sessionId === parentSessionId ||
    triageSessionIds.has(event.sessionId) ||
    repairSessionIds.has(event.sessionId) ||
    event.payload?.triageSessionId ||
    event.payload?.repairSessionId ||
    String(event.type).startsWith('opportunist.')
  ) : events;
  const counts = related.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});
  const messages = related
    .filter((event) => event.type === 'session.message' || event.type === 'session.final-answer' || event.type === 'session.reasoning')
    .map((event) => `#${event.seq} ${event.type} ${JSON.stringify(event.payload)}`);
  const tools = related
    .filter((event) => event.type === 'session.tool' || String(event.type).includes('commandExecution'))
    .map((event) => `#${event.seq} ${event.type} ${JSON.stringify(event.payload)} ext=${JSON.stringify(event.ext)}`);
  const lines = related.slice(-80).map((event) => {
    const text = event.payload?.text ? ` ${String(event.payload.text).replace(/\s+/g, ' ').slice(0, 220)}` : '';
    const tool = event.payload?.tool ? ` tool=${JSON.stringify(event.payload.tool).slice(0, 220)}` : '';
    const code = event.ext?.classification?.code ? ` code=${event.ext.classification.code}` : '';
    return `#${event.seq} ${event.type} ${event.sessionId ?? ''}${code}${text}${tool}`;
  });
  const findings = parentSessionId ? await runtime.invoke('opportunist-findings', { sessionId: parentSessionId }) : await runtime.invoke('opportunist-findings', {});
  return [
    `parentSessionId=${parentSessionId ?? '(none)'}`,
    `findings=${JSON.stringify(findings)}`,
    `counts=${JSON.stringify(counts)}`,
    `messages:\n${messages.join('\n')}`,
    `tools:\n${tools.join('\n')}`,
    `events:\n${lines.join('\n')}`
  ].join('\n');
}

test('LIVE codex: sumo install + opportunist triages a lingering failure and repair subagent fixes it', { timeout: 720_000 }, async (t) => {
  const codexConfig = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!codexConfig) return;

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-opportunist-e2e-'));
  writeProject(projectDir);
  const ctx = await openTempDb({ prefix: 'sumo-opportunist-e2e-db-', idleShutdownMs: 600_000 });
  const previousSumoHome = process.env.SUMO_HOME;
  process.env.SUMO_HOME = ctx.home;
  const env = liveEnv();
  const out = sink();
  let parentSessionId;
  let triageSessionId;
  let repairSessionId;

  const runtime = plugin({
    cwd: projectDir,
    flags: {},
    env,
    db: ctx.db,
    config: {
      use: [],
      harness: {
        default: 'codex',
        codex: {
          ...codexConfig,
          cwd: projectDir,
          sandbox: 'workspace-write',
          approvalPolicy: 'never'
        }
      },
      plugins: { opportunist: { harness: 'codex' } }
    }
  });
  runtime.sumo
    .use(allowApprovals)
    .use(opportunist, { harness: 'codex' });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });

  try {
    assert.equal(await install({ projectDir, yes: true, env, db: ctx.db, out: out.out }), 0, out.text());
    assert.ok(fs.existsSync(codexHarness.path(projectDir)), 'sumo install wrote Codex hooks');

    await runtime.start();
    const spawned = await orch.control('', 'spawn', {
      prompt: parentPrompt(),
      harness: 'codex',
      cwd: projectDir,
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t)) return;
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    parentSessionId = spawned.value.sessionId;

    const tail = await waitForDbTailEvidence(ctx.db, parentSessionId);
    assert.ok(tail.eventCount > 0, `expected database tail output for ${parentSessionId}`);

    let finding;
    try {
      finding = await waitForFindingOrLiveSkip(runtime, ctx.db, parentSessionId, t);
      if (!finding) return;
    } catch (err) {
      throw new Error(`${/** @type {Error} */ (err).message}\n${await diagnostics(ctx.db, runtime, parentSessionId)}`);
    }
    triageSessionId = await waitUntil(async () => {
      const result = await runtime.invoke('opportunist-findings', { sessionId: parentSessionId });
      assert.equal(result.ok, true);
      const current = result.value.findings.find((item) => item.id === finding.id);
      return current?.triageSessionId ? current.triageSessionId : false;
    }, { timeoutMs: 180_000, intervalMs: 1000 });
    assert.notEqual(triageSessionId, parentSessionId, 'opportunist must triage in a separate spawned session');

    try {
      await waitForTriageDecisionBlock(ctx.db, String(triageSessionId));
    } catch (err) {
      throw new Error(`${/** @type {Error} */ (err).message}\n${await diagnostics(ctx.db, runtime, parentSessionId)}`);
    }

    repairSessionId = await waitUntil(async () => {
      const result = await runtime.invoke('opportunist-findings', { sessionId: parentSessionId });
      assert.equal(result.ok, true);
      const current = result.value.findings.find((item) => item.id === finding.id);
      return current?.repairSessionId ? current.repairSessionId : false;
    }, { timeoutMs: 180_000, intervalMs: 1000 });
    assert.notEqual(repairSessionId, parentSessionId, 'opportunist must repair in a separate spawned session');
    assert.notEqual(repairSessionId, triageSessionId, 'repair must be separate from triage');

    assert.equal(finding.sessionId, parentSessionId);
    assert.ok(['dismissive', 'verification'].includes(String(finding.kind)), `unexpected finding kind: ${JSON.stringify(finding)}`);
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'greeting.mjs')), 'parent agent created the requested feature file');
    assert.ok(fs.existsSync(path.join(projectDir, 'test', 'greeting.test.mjs')), 'parent agent created the requested feature test');

    const events = await allEvents(ctx.db);
    assert.ok(events.some((event) => event.type === 'opportunist.finding-detected' && event.payload?.id === finding.id));
    assert.ok(events.some((event) => event.type === 'opportunist.triage-started' && event.payload?.triageSessionId === triageSessionId));
    assert.ok(events.some((event) => event.type === 'opportunist.repair-started' && event.payload?.repairSessionId === repairSessionId));

    const unavailable = await liveUnavailableCode(ctx.db, [parentSessionId, String(triageSessionId), String(repairSessionId)]);
    if (unavailable) t.skip(`codex opportunist live prerequisite unavailable after spawn: ${unavailable}`);

    let resolved;
    try {
      resolved = await waitForRepairResolved(runtime, ctx.db, parentSessionId, String(finding.id), String(triageSessionId), String(repairSessionId), t);
      if (!resolved) return;
      await waitForChildResultBlock(ctx.db, String(repairSessionId));
    } catch (err) {
      throw new Error(`${/** @type {Error} */ (err).message}\n${await diagnostics(ctx.db, runtime, parentSessionId)}`);
    }

    const afterRepairEvents = await allEvents(ctx.db);
    const parentDone = afterRepairEvents.find((event) => event.sessionId === parentSessionId && event.type === 'session.turn-completed');
    const triageStarted = afterRepairEvents.find((event) => event.type === 'opportunist.triage-started' && event.payload?.triageSessionId === triageSessionId);
    const repairResolved = afterRepairEvents.find((event) => event.type === 'opportunist.repair-resolved' && event.payload?.repairSessionId === repairSessionId);
    const triageEvents = afterRepairEvents.filter((event) => event.sessionId === triageSessionId);
    const childEvents = afterRepairEvents.filter((event) => event.sessionId === repairSessionId);
    assert.ok(parentDone, 'parent session completed its requested turn');
    assert.ok(triageStarted, 'opportunist emitted triage-started for the triage child');
    assert.ok(repairResolved, 'opportunist emitted repair-resolved for the child session');
    assert.ok(Number(triageStarted.seq) > Number(parentDone.seq), 'triage started after the parent task turn completed');
    assert.ok(Number(repairResolved.seq) > Number(parentDone.seq), 'repair resolved after the parent task turn completed');
    assert.ok(triageEvents.some((event) => event.type === 'session.tool' && /opportunist-findings|events --session/.test(JSON.stringify(event.payload))), 'triage child inspected Sumo context');
    assert.ok(childEvents.some((event) => event.type === 'session.tool' && /npm test/.test(JSON.stringify(event.payload))), 'repair child ran the project test command');
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.resolutionStatus, 'fixed');
    assert.match(fs.readFileSync(path.join(projectDir, 'src', 'legacy.mjs'), 'utf8'), /return\s+42/);
    const projectTest = runProjectTests(projectDir);
    assert.equal(projectTest.status, 0, `${projectTest.stdout}\n${projectTest.stderr}`);
  } finally {
    if (repairSessionId) {
      await waitUntil(async () => {
        const events = await allEvents(ctx.db);
        return events.some((event) =>
          (event.type === 'opportunist.repair-resolved' || event.type === 'opportunist.repair-inconclusive') &&
          event.payload?.repairSessionId === repairSessionId
        );
      }, { timeoutMs: 30_000, intervalMs: 500 }).catch(() => {});
      await orch.control(String(repairSessionId), 'end', { force: true }).catch(() => {});
    }
    if (triageSessionId) await orch.control(String(triageSessionId), 'end', { force: true }).catch(() => {});
    if (parentSessionId) await orch.control(parentSessionId, 'end', { force: true }).catch(() => {});
    await runtime.stop().catch(() => {});
    orch.stop();
    if (previousSumoHome === undefined) delete process.env.SUMO_HOME;
    else process.env.SUMO_HOME = previousSumoHome;
    await closeTempDb(ctx);
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
