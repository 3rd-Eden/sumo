/**
 * End-to-end smoke test for Claude Code hook wiring.
 *
 * Auto-skips when the `claude` CLI is not installed or not
 * authenticated.  Spawns a real single-turn session with
 * `--print --include-hook-events` and parses the stream-json
 * output to verify each hook fires and returns exit code 0.
 *
 * This is the test that would have caught the `decision: "allow"`
 * schema violation before it reached a live user session.
 *
 * @see .agents/skills/campsite-rule/bin/hook.js
 */
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll } from 'vitest';

const shell = promisify(exec);

/**
 * Detect whether the claude CLI is installed and authenticated.
 *
 * @returns {Promise<boolean>}
 */
async function available() {
  try {
    const { stdout } = await shell('claude auth status --json 2>/dev/null', {
      timeout: 10_000
    });
    const status = JSON.parse(stdout.trim());
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

const ready = await available();

describe.skipIf(!ready)('claude e2e smoke', function smoke() {
  /**
   * Parsed hook events from the stream-json output.
   *
   * @type {{ hook_event: string, hook_name: string, exit_code: number, outcome: string, output: string }[]}
   */
  let events;

  /**
   * Whether the session completed its turn normally (vs. budget
   * exceeded, API error, or timeout).  When false, the Stop hook
   * legitimately does not fire.
   *
   * @type {boolean}
   */
  let completed;

  beforeAll(async function session() {
    const stdout = await new Promise(function run(resolve, reject) {
      const child = spawn('claude', [
        '-p',
        '--include-hook-events',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-budget-usd', '2.00',
        '--model', 'sonnet',
        'Reply with exactly one word: hello'
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
      });

      let out = '';

      child.stdout.on('data', function collect(chunk) {
        out += chunk;
      });

      const timer = setTimeout(function kill() {
        child.kill();
        reject(new Error('claude timed out after 60s'));
      }, 60_000);

      child.on('close', function done() {
        clearTimeout(timer);
        resolve(out);
      });
    });

    const lines = stdout
      .split('\n')
      .filter(Boolean)
      .map(function parse(line) {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    events = lines.filter(function hook(l) {
      return l.type === 'system' && l.subtype === 'hook_response';
    });

    const result = lines.find(function end(l) {
      return l.type === 'result';
    });

    completed = result != null && !result.is_error;
  }, 90_000);

  it('SessionStart hook fires and succeeds', function start() {
    const hit = events.find(function match(e) {
      return e.hook_event === 'SessionStart' && e.hook_name?.includes('startup');
    });

    expect(hit, 'SessionStart:startup hook did not fire').toBeDefined();
    expect(hit.exit_code).toBe(0);
    expect(hit.outcome).toBe('success');
  });

  it('SessionStart hook returns valid JSON', function json() {
    const hit = events.find(function match(e) {
      return e.hook_event === 'SessionStart' && e.hook_name?.includes('startup');
    });

    const output = JSON.parse(hit.output);
    expect(output).not.toHaveProperty('decision');
  });

  it('Stop hook fires and succeeds when session completes', function stop() {
    if (!completed) return;

    const hit = events.find(function match(e) {
      return e.hook_event === 'Stop';
    });

    expect(hit, 'Stop hook did not fire').toBeDefined();
    expect(hit.exit_code).toBe(0);
    expect(hit.outcome).toBe('success');
  });

  it('Stop hook returns valid schema-compliant JSON', function stopJson() {
    const hit = events.find(function match(e) {
      return e.hook_event === 'Stop';
    });

    if (!hit) return;

    const output = JSON.parse(hit.output);

    if ('decision' in output) {
      expect(output.decision).toBe('block');
      expect(output.reason).toBeDefined();
    }
  });

  it('no hook errors in the session', function noErrors() {
    const errors = events.filter(function bad(e) {
      return e.exit_code !== 0 || e.outcome !== 'success';
    });

    const summary = errors.map(function describe(e) {
      return `${e.hook_name}: exit ${e.exit_code} (${e.outcome}) — ${e.stderr || 'no stderr'}`;
    });

    expect(errors, `Hook errors:\n${summary.join('\n')}`).toHaveLength(0);
  });
});
