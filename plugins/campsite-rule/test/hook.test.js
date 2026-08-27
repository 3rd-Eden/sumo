/**
 * Integration tests for the shared campsite hook adapter.
 *
 * Each test spawns the real hook script as a child process, pipes a
 * JSON payload to stdin, and reads the JSON response from stdout.
 * State files are written to a temp directory scoped to each test to
 * avoid cross-contamination between scenarios.
 *
 * Tests cover both Cursor and Claude host modes.  Engine-level
 * detection logic is tested separately in `engine.test.js`.
 *
 * @see .agents/skills/campsite-rule/bin/hook.js
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const hook = join(import.meta.dirname, '..', 'bin', 'hook.js');
const fixtures = join(import.meta.dirname, 'fixtures', 'payloads');
const policy = join(import.meta.dirname, '..', 'SKILL.md');
const repoRoot = join(import.meta.dirname, '..', '..', '..');

let sessionId;
let stateFile;
let tempLedgerDir;

/**
 * Finding IDs detected during the current test.
 *
 * Populated by reading the session state file before cleanup so we
 * only prune ledger entries that *this* test created.
 *
 * @type {string[]}
 */
let testFindingIds;

beforeEach(async function setup() {
  sessionId = `test-${randomBytes(8).toString('hex')}`;
  stateFile = join(tmpdir(), `campsite-${sessionId}.json`);
  tempLedgerDir = await mkdtemp(join(tmpdir(), 'campsite-ledger-'));
  testFindingIds = [];
});

afterEach(async function cleanup() {
  await collectFindingIds();
  await rm(stateFile, { force: true });
  await rm(tempLedgerDir, { recursive: true, force: true });
  await pruneLedger();
});

/**
 * Snapshot the finding IDs from the session state before it is removed.
 */
async function collectFindingIds() {
  try {
    const data = JSON.parse(await readFile(stateFile, 'utf8'));
    const findings = data.findings ?? [];
    const ids = new Set(testFindingIds);

    for (const finding of findings) {
      ids.add(finding.id);
    }

    testFindingIds = Array.from(ids);
  } catch {
    testFindingIds = [...testFindingIds];
  }
}

/**
 * Remove only this test's ledger entries, preserving real session data.
 */
async function pruneLedger() {
  if (testFindingIds.length === 0) return;

  const base = join(homedir(), '.local', 'share', 'campsite');
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
  const ledger = join(base, hash, 'ledger.json');
  const ids = new Set(testFindingIds);

  try {
    const data = JSON.parse(await readFile(ledger, 'utf8'));
    const pruned = {};

    for (const [id, entry] of Object.entries(data)) {
      if (ids.has(id)) continue;
      pruned[id] = entry;
    }

    if (Object.keys(pruned).length === 0) {
      await rm(join(base, hash), { recursive: true, force: true });
    } else {
      await writeFile(ledger, JSON.stringify(pruned, null, 2), 'utf8');
    }
  } catch {
    /* ledger may not exist */
  }
}

/**
 * Invoke the hook script with a given host, mode, and JSON payload.
 *
 * @param {string} host - Host name (`cursor` or `claude`).
 * @param {string} mode - CLI argument passed to hook.js.
 * @param {object} payload - JSON object piped to stdin.
 * @returns {Promise<object>} Parsed JSON from stdout.
 */
function invoke(host, mode, payload) {
  const merged = { ...payload, session_id: sessionId };

  return new Promise(function run(resolve, reject) {
    const child = spawn('node', [hook, '--host', host, '--repo', repoRoot, mode], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', function collect(chunk) {
      stdout += chunk;
    });

    child.stderr.on('data', function collect(chunk) {
      stderr += chunk;
    });

    child.on('close', function done(code) {
      if (code !== 0) {
        reject(new Error(`Hook exited ${code}: ${stderr}`));
        return;
      }

      const parsed = stdout ? JSON.parse(stdout) : {};

      if (mode === 'resolve' && typeof parsed.resolved === 'string' && !testFindingIds.includes(parsed.resolved)) {
        testFindingIds.push(parsed.resolved);
      }

      resolve(parsed);
    });

    child.stdin.write(JSON.stringify(merged));
    child.stdin.end();
  });
}

/**
 * Invoke the hook with a raw stdin string to test malformed JSON handling.
 *
 * @param {string} host
 * @param {string} mode
 * @param {string} payload
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function invokeRaw(host, mode, payload) {
  return new Promise(function run(resolve) {
    const child = spawn('node', [hook, '--host', host, '--repo', repoRoot, mode], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', function collect(chunk) {
      stdout += chunk;
    });

    child.stderr.on('data', function collect(chunk) {
      stderr += chunk;
    });

    child.on('close', function done(code) {
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * Read the persisted state file and return parsed JSON.
 *
 * @returns {Promise<object|null>} State object, or null if absent.
 */
async function state() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

// ── Cursor host tests ──────────────────────────────────────────────

describe('cursor: agent-response dismissive language detection', function response() {
  it('detects dismissive phrases in agent response text', async function detect() {
    const payload = JSON.parse(await readFile(join(fixtures, 'response-dismissive.json'), 'utf8'));
    await invoke('cursor', 'agent-response', payload);

    const persisted = await state();
    expect(persisted.findings).toBeDefined();
    expect(persisted.findings).toContainEqual(
      expect.objectContaining({
        kind: 'dismissive',
        source: 'response',
        phrase: 'pre-existing'
      })
    );
  });

  it('ignores clean response text', async function clean() {
    const payload = JSON.parse(await readFile(join(fixtures, 'response-clean.json'), 'utf8'));
    await invoke('cursor', 'agent-response', payload);

    expect(await state()).toBeNull();
  });
});

describe('cursor: agent-thought compatibility mode', function thought() {
  it('ignores dismissive phrases in thinking blocks', async function detect() {
    const payload = JSON.parse(await readFile(join(fixtures, 'thought-dismissive.json'), 'utf8'));
    await invoke('cursor', 'agent-thought', payload);

    expect(await state()).toBeNull();
  });
});

describe('cursor: tool-success exit code awareness', function exitCode() {
  it('records failure when verification exits non-zero', async function records() {
    const payload = JSON.parse(await readFile(join(fixtures, 'tool-success-fail.json'), 'utf8'));
    await invoke('cursor', 'tool-success', payload);

    const persisted = await state();
    expect(persisted.findings).toContainEqual(
      expect.objectContaining({
        kind: 'verification',
        command: 'bin/onboard test',
        failureType: 'non_zero_exit'
      })
    );
  });

  it('ignores non-verification commands', async function ignores() {
    const payload = JSON.parse(await readFile(join(fixtures, 'tool-success-nonverification.json'), 'utf8'));
    await invoke('cursor', 'tool-success', payload);

    expect(await state()).toBeNull();
  });

  it('ignores piped resolve commands whose payload contains verification text', async function pipedResolve() {
    await invoke('cursor', 'tool-success', {
      session_id: sessionId,
      tool_name: 'Shell',
      tool_input: {
        command: 'printf \'{"verificationCommand":"bin/onboard test"}\' | node .agents/skills/campsite-rule/bin/hook.js --repo . resolve'
      },
      tool_output: '{"resolved":"abc123"}'
    });

    expect(await state()).toBeNull();
  });

  it('ignores resolve commands with cd prefix and verification text in payload', async function cdResolve() {
    await invoke('cursor', 'tool-success', {
      session_id: sessionId,
      tool_name: 'Shell',
      tool_input: {
        command: 'cd /repo && printf \'{"verificationCommand":"bin/onboard test"}\' | node .agents/skills/campsite-rule/bin/hook.js --repo . resolve 2>&1'
      },
      tool_output: '{"resolved":"abc123"}'
    });

    expect(await state()).toBeNull();
  });

  it('ignores resolve commands with verification pattern in evidence text', async function evidenceResolve() {
    await invoke('cursor', 'tool-success', {
      session_id: sessionId,
      tool_name: 'Shell',
      tool_input: {
        command: 'cd /repo && printf \'{"evidence":"bin/onboard test-skills is invalid"}\' | node .agents/skills/campsite-rule/bin/hook.js --repo . resolve 2>&1'
      },
      tool_output: '{"resolved":"abc123"}'
    });

    expect(await state()).toBeNull();
  });
});

describe('cursor: stop handler', function stopHandler() {
  it('fires followup_message when verification failed', async function verification() {
    const fail = JSON.parse(await readFile(join(fixtures, 'tool-success-fail.json'), 'utf8'));
    await invoke('cursor', 'tool-success', fail);

    const result = await invoke('cursor', 'stop', { status: 'completed' });
    expect(result.followup_message).toContain('Campsite hook flagged 1 concrete issue');
    expect(result.followup_message).toContain('verification command failed in this session');
  });

  it('fires followup_message when dismissive language detected', async function dismissive() {
    const response = JSON.parse(await readFile(join(fixtures, 'response-dismissive.json'), 'utf8'));
    await invoke('cursor', 'agent-response', response);

    const result = await invoke('cursor', 'stop', { status: 'completed' });
    expect(result.followup_message).toContain('Dismissive language detected');
    expect(result.followup_message).toContain('pre-existing');
  });

  it('stays silent when no issues found', async function silent() {
    const result = await invoke('cursor', 'stop', { status: 'completed' });
    expect(result).toStrictEqual({});
  });

  it('stays silent for non-completed sessions', async function aborted() {
    const fail = JSON.parse(await readFile(join(fixtures, 'tool-success-fail.json'), 'utf8'));
    await invoke('cursor', 'tool-success', fail);

    const result = await invoke('cursor', 'stop', { status: 'aborted' });
    expect(result).toStrictEqual({});
  });
});

describe('cursor: resolve mode', function resolveMode() {
  it('resolves a finding by ID', async function resolve() {
    const response = JSON.parse(await readFile(join(fixtures, 'response-dismissive.json'), 'utf8'));
    await invoke('cursor', 'agent-response', response);

    const persisted = await state();
    const findingId = persisted.findings[0].id;

    const result = await invoke('cursor', 'resolve', {
      findingId,
      classification: 'fixed',
      evidence: policy,
      subject: 'policy-docs',
      model: 'claude-opus-4.6',
      effort: 'high'
    });

    expect(result.resolved).toBe(findingId);
  });

  it('returns error when findingId is missing', async function missing() {
    const result = await invoke('cursor', 'resolve', { classification: 'fixed' });
    expect(result.error).toContain('missing findingId');
  });

  it('returns error for malformed resolve JSON instead of crashing', async function malformed() {
    const result = await invokeRaw('cursor', 'resolve', '{"findingId":');

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/json/i)
      })
    );
  });
});

// ── Claude host tests ──────────────────────────────────────────────

describe('claude: tool-success with tool_response field', function claudeToolSuccess() {
  it('records failure when Claude Bash verification exits non-zero', async function records() {
    const payload = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', payload);

    const persisted = await state();
    expect(persisted.findings).toContainEqual(
      expect.objectContaining({
        kind: 'verification',
        command: 'bin/onboard test',
        failureType: 'non_zero_exit'
      })
    );
  });

  it('clears matching verification findings when Claude Bash verification exits zero', async function pass() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const pass = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-pass.json'), 'utf8'));
    await invoke('claude', 'tool-success', pass);

    const persisted = await state();
    expect(
      (persisted?.findings ?? []).some(function v(f) {
        return f.kind === 'verification';
      })
    ).toBe(false);
  });
});

describe('claude: tool-failure with error field', function claudeToolFailure() {
  it('records failure from Claude PostToolUseFailure error string', async function records() {
    const payload = JSON.parse(await readFile(join(fixtures, 'claude-tool-failure.json'), 'utf8'));
    await invoke('claude', 'tool-failure', payload);

    const persisted = await state();
    expect(persisted.findings).toContainEqual(
      expect.objectContaining({
        kind: 'verification',
        command: 'bin/onboard test'
      })
    );
  });
});

describe('claude: stop handler with transcript scanning', function claudeStop() {
  it('scans latest visible transcript response for dismissive language and blocks', async function dismissive() {
    const transcriptPath = join(fixtures, 'claude-transcript-dismissive.jsonl');
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: transcriptPath
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Dismissive language detected');
    expect(result.reason).toContain('pre-existing');
  });

  it('ignores dismissive phrases in transcript thinking blocks', async function thinking() {
    const transcriptPath = join(fixtures, 'claude-transcript-thinking-only.jsonl');
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: transcriptPath
    });

    expect(result).toStrictEqual({});
  });

  it('allows when transcript contains no dismissive language', async function clean() {
    const transcriptPath = join(fixtures, 'claude-transcript-clean.jsonl');
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: transcriptPath
    });

    expect(result).toStrictEqual({});
  });

  it('allows when stop_hook_active is true to prevent loops', async function active() {
    const payload = JSON.parse(await readFile(join(fixtures, 'claude-stop-active.json'), 'utf8'));
    const result = await invoke('claude', 'stop', payload);

    expect(result).toStrictEqual({});
  });

  it('allows when transcript_path is missing', async function missing() {
    const result = await invoke('claude', 'stop', { stop_hook_active: false });

    expect(result).toStrictEqual({});
  });

  it('blocks with combined verification and transcript dismissive findings', async function combined() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const transcriptPath = join(fixtures, 'claude-transcript-dismissive.jsonl');
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: transcriptPath
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('verification command failed');
    expect(result.reason).toContain('Dismissive language detected');
  });

  it('gracefully handles a nonexistent transcript path', async function nonexistent() {
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: '/tmp/does-not-exist-campsite-test.jsonl'
    });

    expect(result).toStrictEqual({});
  });
});

describe('claude: subagent-stop handler', function subagentStop() {
  it('scans subagent transcript and blocks on dismissive language', async function blocks() {
    const transcriptPath = join(fixtures, 'claude-transcript-dismissive.jsonl');
    const result = await invoke('claude', 'subagent-stop', {
      stop_hook_active: false,
      agent_transcript_path: transcriptPath
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Dismissive language detected');
  });

  it('allows clean subagent transcript', async function allows() {
    const transcriptPath = join(fixtures, 'claude-transcript-clean.jsonl');
    const result = await invoke('claude', 'subagent-stop', {
      stop_hook_active: false,
      agent_transcript_path: transcriptPath
    });

    expect(result).toStrictEqual({});
  });

  it('allows when stop_hook_active is true', async function loop() {
    const result = await invoke('claude', 'subagent-stop', {
      stop_hook_active: true,
      agent_transcript_path: join(fixtures, 'claude-transcript-dismissive.jsonl')
    });

    expect(result).toStrictEqual({});
  });
});

describe('claude: pretool test-command blocking', function pretool() {
  it('denies pnpm test with descriptive reason', async function pnpmTest() {
    const payload = JSON.parse(await readFile(join(fixtures, 'claude-pretool-test-command.json'), 'utf8'));
    const result = await invoke('claude', 'pretool', payload);

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('bin/onboard test');
  });

  it('denies npm run test', async function npmRunTest() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'npm run test' }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies npx vitest', async function npxVitest() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest' }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies node --test', async function nodeTest() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'node --test src/' }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies node_modules/.bin/vitest', async function binVitest() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'node_modules/.bin/vitest run' }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows non-test commands', async function allows() {
    const payload = JSON.parse(await readFile(join(fixtures, 'claude-pretool-safe-command.json'), 'utf8'));
    const result = await invoke('claude', 'pretool', payload);

    expect(result).toStrictEqual({});
  });

  it('allows bin/onboard test', async function allowsOnboard() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'bin/onboard test' }
    });

    expect(result).toStrictEqual({});
  });
});

describe('claude: pretool campsite-bypass blocking', function campsitePretool() {
  it('denies node -e with campsite-rule imports', async function nodeEval() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: {
        command: 'node --input-type=module -e \'import { CampsiteEngine } from "campsite-rule/src/index.js"\''
      }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('SKILL.md');
  });

  it('denies direct ledger file access', async function ledgerAccess() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'cat ~/.local/share/campsite/abc123/ledger.json' }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies node --eval with campsite-rule reference', async function nodeEvalAlt() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: {
        command: 'node --eval \'import("./.agents/skills/campsite-rule/src/engine.js")\''
      }
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows normal commands through', async function passthrough() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    });

    expect(result).toStrictEqual({});
  });

  it('allows bin/onboard run with quoted pnpm test commands', async function onboardRun() {
    const result = await invoke('claude', 'pretool', {
      tool_name: 'Bash',
      tool_input: { command: 'bin/onboard run "pnpm run test:skills"' }
    });

    expect(result).toStrictEqual({});
  });
});

describe('import guard', function guard() {
  /**
   * Spawn a Node.js process that attempts a module import and collect
   * the exit code and stderr.
   *
   * @param {string} importPath - Relative import path from the repo root.
   * @returns {Promise<{code: number, stderr: string}>}
   */
  function attempt(importPath) {
    const env = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    return new Promise(function run(resolve) {
      const child = spawn('node', [
        '--input-type=module',
        '-e',
        `import '${importPath}'`
      ], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], env });

      let stderr = '';

      child.stderr.on('data', function collect(chunk) {
        stderr += chunk;
      });

      child.on('close', function done(code) {
        resolve({ code, stderr });
      });

      child.stdin.end();
    });
  }

  it('blocks direct import of index.js', async function index() {
    const { code, stderr } = await attempt('./plugins/campsite-rule/src/index.js');

    expect(code).not.toBe(0);
    expect(stderr).toContain('direct import denied');
  });

  it('blocks direct import of engine.js', async function engine() {
    const { code, stderr } = await attempt('./plugins/campsite-rule/src/engine.js');

    expect(code).not.toBe(0);
    expect(stderr).toContain('direct import denied');
  });

  it('blocks direct import of ledger.js', async function ledger() {
    const { code, stderr } = await attempt('./plugins/campsite-rule/src/ledger.js');

    expect(code).not.toBe(0);
    expect(stderr).toContain('direct import denied');
  });

  it('includes SKILL.md path in error message', async function skillReference() {
    const { stderr } = await attempt('./plugins/campsite-rule/src/index.js');

    expect(stderr).toContain('SKILL.md');
  });
});

describe('session-start generates nonce', function nonceLifecycle() {
  it('writes a nonce to session state', async function writesNonce() {
    await invoke('cursor', 'session-start', {});

    const data = await state();

    expect(data).not.toBeNull();
    expect(data.nonce).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rotates nonce on each session-start', async function rotatesNonce() {
    await invoke('cursor', 'session-start', {});
    const first = await state();

    await invoke('cursor', 'session-start', {});
    const second = await state();

    expect(first.nonce).not.toBe(second.nonce);
  });
});

// ── Shared behavior tests ──────────────────────────────────────────

describe('session-start clears temp state', function sessionStart() {
  it('clears state on session-start for cursor', async function cursor() {
    const response = JSON.parse(await readFile(join(fixtures, 'response-dismissive.json'), 'utf8'));
    await invoke('cursor', 'agent-response', response);

    const before = await state();
    expect(before.findings.length).toBeGreaterThan(0);

    await invoke('cursor', 'session-start', {});

    const after = await state();
    expect(after.findings).toStrictEqual([]);
    expect(after.nonce).toBeDefined();
  });

  it('clears state on session-start for claude', async function claude() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const before = await state();
    expect(before.findings.length).toBeGreaterThan(0);

    await invoke('claude', 'session-start', {});

    const after = await state();
    expect(after.findings).toStrictEqual([]);
    expect(after.nonce).toBeDefined();
  });

  it('preserves state on session-start with source=resume', async function resume() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const before = await state();
    expect(before).not.toBeNull();
    expect(before.findings.length).toBeGreaterThan(0);

    await invoke('claude', 'session-start', { source: 'resume' });

    const after = await state();
    expect(after).not.toBeNull();
    expect(after.findings.length).toBe(before.findings.length);
  });

  it('clears state on session-start with source=startup', async function startup() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const before = await state();
    expect(before.findings.length).toBeGreaterThan(0);

    await invoke('claude', 'session-start', { source: 'startup' });

    const after = await state();
    expect(after.findings).toStrictEqual([]);
    expect(after.nonce).toBeDefined();
  });

  it('clears state on session-start with source=compact', async function compact() {
    const fail = JSON.parse(await readFile(join(fixtures, 'claude-tool-success-fail.json'), 'utf8'));
    await invoke('claude', 'tool-success', fail);

    const before = await state();
    expect(before.findings.length).toBeGreaterThan(0);

    await invoke('claude', 'session-start', { source: 'compact' });

    const after = await state();
    expect(after.findings).toStrictEqual([]);
    expect(after.nonce).toBeDefined();
  });
});

describe('unknown mode returns empty', function unknownMode() {
  it('returns empty object for cursor', async function cursor() {
    const result = await invoke('cursor', 'nonsense', {});
    expect(result).toStrictEqual({});
  });

  it('returns empty object for claude', async function claude() {
    const result = await invoke('claude', 'nonsense', {});
    expect(result).toStrictEqual({});
  });
});

describe('--repo handling', function repoFlag() {
  it('uses repo root for config discovery', async function configDiscovery() {
    const fail = JSON.parse(await readFile(join(fixtures, 'tool-success-fail.json'), 'utf8'));
    await invoke('cursor', 'tool-success', fail);

    const persisted = await state();
    expect(persisted.findings).toContainEqual(expect.objectContaining({ kind: 'verification' }));
  });
});

describe('neutral storage defaults', function neutralDefaults() {
  it('uses campsite- prefix for state files', function prefix() {
    expect(stateFile).toContain('campsite-');
    expect(stateFile).not.toContain('cursor-campsite-');
  });
});

// ── Schema validation tests ────────────────────────────────────────

describe('schema validation is active on all responses', function schema() {
  it('Claude stop returns {} not decision:"allow" (the exact bug this prevents)', async function stopShape() {
    const result = await invoke('claude', 'stop', { stop_hook_active: false });
    expect(result).toStrictEqual({});
    expect(result).not.toHaveProperty('decision');
  });

  it('Claude subagent-stop returns {} when clean', async function subagentShape() {
    const transcriptPath = join(fixtures, 'claude-transcript-clean.jsonl');
    const result = await invoke('claude', 'subagent-stop', {
      stop_hook_active: false,
      agent_transcript_path: transcriptPath
    });
    expect(result).toStrictEqual({});
    expect(result).not.toHaveProperty('decision');
  });

  it('Claude stop uses decision:"block" with reason when blocking', async function blockShape() {
    const transcriptPath = join(fixtures, 'claude-transcript-dismissive.jsonl');
    const result = await invoke('claude', 'stop', {
      stop_hook_active: false,
      transcript_path: transcriptPath
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toBeDefined();
  });
});
