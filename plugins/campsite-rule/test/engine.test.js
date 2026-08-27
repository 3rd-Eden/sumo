/**
 * Integration tests for the campsite-rule enforcement engine.
 *
 * Validates the full detection pipeline: two-stage phrase matching,
 * analytical-context filtering, finding identity, legacy state migration,
 * resolution ledger proofs, and stop-time gating evaluation.
 *
 * @see .agents/skills/campsite-rule/src/engine.js
 */
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CampsiteEngine } from '../src/engine.js';
import { analytical, candidates, detect, fingerprint, migrate, verification } from '../src/findings.js';
import { defaults } from '../src/config.js';
import { ResolutionLedger } from '../src/ledger.js';

let tempDir;
let statePath;

beforeEach(async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'campsite-engine-test-'));
  statePath = join(tempDir, 'state.json');
});

afterEach(async function cleanup() {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Create a real artifact file for `fixed` evidence validation.
 *
 * Fixed resolutions must point at something verifiable, so tests create a
 * real file inside the temp repo and reference its absolute path.
 *
 * @param {string} [name]
 * @returns {Promise<string>}
 */
async function artifact(name = 'artifact.md') {
  const path = join(tempDir, name);
  await writeFile(path, '# artifact\n');
  return path;
}

/**
 * Build a valid fixed proof for resolution tests.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function fixedProof(overrides = {}) {
  return {
    classification: 'fixed',
    evidence: overrides.evidence ?? '',
    subject: overrides.subject ?? 'policy-docs',
    model: 'claude-opus-4.6',
    effort: 'high',
    ...overrides
  };
}

/**
 * Create a successful verification transcript for rerun-proof validation.
 *
 * The proof contract accepts a real artifact that shows the same verification
 * command exiting zero. Tests use a temp file rather than a mocked helper so
 * the ledger validates an actual file on disk.
 *
 * @param {object} [options]
 * @param {string} [options.command]
 * @param {number} [options.exitCode]
 * @param {string} [options.name]
 * @returns {Promise<string>}
 */
async function rerun(options = {}) {
  const command = options.command ?? 'bin/onboard test';
  const exitCode = options.exitCode ?? 0;
  const name = options.name ?? 'rerun.json';
  const path = join(tempDir, name);

  await writeFile(
    path,
    JSON.stringify({
      tool_name: 'Shell',
      tool_input: { command },
      tool_output: JSON.stringify({ exitCode, stdout: exitCode === 0 ? 'All tests passed' : '7 failed' }),
      cwd: '/project'
    }),
    'utf8'
  );

  return path;
}

describe('detection pipeline', function pipeline() {
  it('detects dismissive phrases in plain text', function plain() {
    const hits = detect('This failure is pre-existing and not related to my change.', 'response');

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits).toContainEqual(
      expect.objectContaining({
        kind: 'dismissive',
        source: 'response',
        phrase: 'pre-existing'
      })
    );
  });

  it('assigns stable finding IDs', function ids() {
    const hits = detect('This is a separate concern from our work.', 'response');
    const again = detect('This is a separate concern from our work.', 'response');

    expect(hits[0].id).toBe(again[0].id);
  });

  it('generates different IDs for different contexts', function contexts() {
    const a = detect('This is a separate concern from A.', 'response');
    const b = detect('This is a separate concern from B.', 'response');

    expect(a[0].id).not.toBe(b[0].id);
  });

  it('collapses overlapping phrases', function overlap() {
    const hits = detect('This is not related to my task.', 'response');
    const phrases = hits.map(function p(h) {
      return h.phrase;
    });

    expect(phrases).toContain('not related to my');
    expect(phrases).not.toContain('not related to');
  });
});

// cspell:ignore triaging
describe('analytical-context filter', function filter() {
  /**
   * Table-driven filter tests.
   *
   * Each entry describes an agent text sample, the source label, and
   * the expected outcome: `null` means every phrase should be rejected
   * (meta/quoted/fenced), a string[] lists phrases that must survive.
   *
   * Entries sourced from the resolution ledger are tagged with their
   * finding ID so regressions trace back to real agent output.
   *
   * @type {Array<{ name: string, text: string, source: string, expect: string[]|null }>}
   */
  const cases = [
    // ── Rejection: backtick / code-fence quoting ──────────────────
    {
      name: 'rejects phrases inside backtick-quoted code',
      text: 'The phrase `separate concern` was flagged by the hook.',
      source: 'response',
      expect: null
    },
    {
      name: 'rejects phrases inside triple-backtick code blocks',
      text: 'Here is the config:\n```\nconst x = "separate concern";\n```\nDone.',
      source: 'response',
      expect: null
    },

    // ── Rejection: quotation-mark wrapping ────────────────────────
    {
      name: 'rejects phrases wrapped in quotation marks as concept references',
      text: 'The dismissive phrase "not part of this" is being discussed.',
      source: 'response',
      expect: null
    },
    {
      name: 'rejects quoted example phrases while discussing meta indicators',
      text: 'I\u2019m thinking that I might accidentally overlook a genuine statement, like \u201cthis is pre-existing and we should flag it.\u201d Is it a meta statement? Well, \u201cflag\u201d could be a strong indicator in this context, but phrases like that should not count.',
      source: 'thought',
      expect: null
    },
    {
      name: 'rejects quoted example phrases about flag behavior',
      text: 'Is it a meta statement? Well, \u201cflag\u201d could be a strong indicator in this context, but phrases like \u201cnot related to flag behavior\u201d probably should not count. Maybe I could add tokens like \u201cconfig.js\u201d without making the filter too broad.',
      source: 'thought',
      expect: null
    },

    // ── Rejection: campsite meta-discussion ─────────────────────
    {
      name: 'rejects meta-discussion naming campsite in same paragraph',
      text: 'The campsite hook keeps flagging "separate concern" as a finding even when we discuss detection behavior.',
      source: 'response',
      expect: null
    },
    {
      name: 'rejects meta-discussion about campsite false-positive resolution',
      text: 'I need to classify four pre-existing thought hits as campsite false positives. The IDs are 0f314c and ec171f.',
      source: 'thought',
      expect: null
    },
    {
      name: 'detects dismissal in cross-paragraph meta-discussion where campsite is in a different paragraph [ec351453]',
      text: [
        "I need to check if the resolutions are still in place. Should I use shell to resolve these? There's this campsite-rule the user mentioned that I have to follow. Since the IDs are the same as before, I guess running resolve commands again might be the way to go. If I need to create or strengthen an artifact, I could quote exact snippets we already have. But I can't modify anything unless told to do so.",
        '**Classifying issues for resolution**',
        '',
        'I\'ve realized that the artifact already exists, so I can just point to it and rerun the resolve commands. I need to classify four pre-existing thought hits as local false positives for IDs 0f314c and ec171f. It might make sense to classify 0f314c as "fixed" since the actual issue is now bounded by the plan artifact, rather than "local." But I should decide on classifications for each issue based on the command schema the user specified. I\'m considering the best approach since the response regarding T3 was somewhat dismissive.',
        '**Assessing issue classification**',
        '',
        "The skill indicates that if the same response had a real issue, I need to classify and route it. There's now an underlying issue with the missing T3 that's part of the plan. So, I think I should find the classification in the ledger, possibly marking it as local or fixed. It seems classification might lean towards \"local\" since it's tied to a specific scope statement, although I'm concerned because the user requested an artifact rather than prose. I should probably verify if the artifact exists before resolving."
      ].join('\n'),
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal in indirect meta-discussion without naming campsite [ffcd95c8]',
      text: [
        '**Updating configurations**',
        '',
        "I'm considering whether to flag a discovered finding if they're not using a pre-existing classification to dismiss it. So, I think it might be fine not to flag it. I need to think about updating the config tests so the analytical filter recognizes this kind of meta discussion."
      ].join('\n'),
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal about diffs without naming campsite [0a192ae0]',
      text: 'The evidence will reference the entire config.js file, which is fine, even if there are pre-existing diffs. But if we commit later, snapshotting snippetRadius might complicate things, and the user did not ask about it.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'rejects triaging under campsite rules [dc6681c0]',
      text: "It's a bit of a juggling act! Assessing pre-existing repo failures. I'm realizing that if there are pre-existing repo failures, we should definitely mention and triage them. According to campsite rules, we can't mark the task as complete until they're addressed.",
      source: 'thought',
      expect: null
    },
    {
      name: 'rejects shorter repo-failure triage meta-discussion [bc14e06a]',
      text: "Assessing pre-existing repo failures. I'm realizing that if there are pre-existing repo failures, we should definitely mention and triage them. According to campsite rules, we can't mark the task as complete until they're addressed.",
      source: 'thought',
      expect: null
    },
    {
      name: 'rejects agent deliberating about counting changes [cc30b81f]',
      text: 'I\'m thinking about being actual triage rather than dismissive. If a text says, "this is pre-existing; we should triage it," that\'s not dismissive and can be filtered. But I wonder if counting duplicated tokens might lead to wrongly filtering out genuine statements. For example, if someone says, "This is pre-existing; we should triage and triage later," it\'s still valid. I\'m considering maintaining a threshold of duplicates while ensuring existing tests remain accurate.',
      source: 'thought',
      expect: null
    },

    // ── Detection: genuine dismissals ─────────────────────────────
    {
      name: 'detects genuine dismissal in ordinary prose',
      text: 'The 2 failures are pre-existing \u2014 not related to our changes.',
      source: 'response',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal with triage language nearby',
      text: 'I need to triage the test suite. The Docker failure is pre-existing and not related to our changes.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal with repeated "flag" nearby',
      text: "That's a red flag \u2014 I'll flag it for later. The Docker failure is not related to our changes.",
      source: 'response',
      expect: ['not related to our']
    },
    {
      name: 'detects dismissal alongside triage reasoning',
      text: 'These failures are pre-existing and someone else owns them. We should triage before the sprint ends.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal in paragraph with triage and threshold language [4aceeae8]',
      text: 'boundaries as well, because the paragraph string might have both headings and sentences. For instance, when looking at pre-existing repo failures, I realize we need to mention and triage any issues. If I use triage, I might meet the requirement threshold.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal with classify/investigate language [d86a5d21]',
      text: "Recent changes, so that's where our focus should be. There are also unrelated packages and metrics failures that could be pre-existing. I think I might need to classify the issues and investigate, but for now, fixing the accessibility tests should be our focus.",
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal near "false-positive" used in non-campsite context [ea947bbd]',
      text: 'cases for the exact reported patterns. I might include a test for unrelated packages and metrics failures that could be pre-existing. I think classifying the issues will help in my investigation. For the IDs d86, dc66, and bc14, they likely correspond to the earlier false-positive patterns.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissive phrase when meta tokens are in a different paragraph',
      text: [
        'The hook and detection pipeline are working correctly.',
        '',
        'That Docker failure is not related to our changes and was pre-existing before we started.'
      ].join('\n'),
      source: 'response',
      expect: ['pre-existing']
    },

    // ── Detection: real-world ledger contexts ─────────────────────
    {
      name: 'detects "unrelated infrastructure issue" [8f9b7fff]',
      text: 'The only failure is packages/llm \u2014 a timeout on a live API request (30s). This is an unrelated infrastructure issue in the example-package module which was not modified in this refactoring.',
      source: 'response',
      expect: ['an unrelated', 'was not modified']
    },
    {
      name: 'detects "classify as out of scope" [b191aaaf]',
      text: 'The apps/mcp failure is pre-existing and unrelated to our changes. I should classify these as out of scope and move on to the next task.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects stacked dismissals [650d70bf]',
      text: "The 2 failures are pre-existing \u2014 they're yaml package import errors in commands.test.js, not related to my change. The apps/mcp test is a separate issue with Node.js 24 compatibility.",
      source: 'response',
      expect: ['pre-existing', 'separate issue']
    },

    // ── Detection: incidental words that used to be meta tokens ───
    {
      name: 'detects dismissal surrounded by classify/flag/triage language',
      text: 'I need to classify these test failures and flag them for the team. The Docker timeout is pre-existing and not related to our changes.',
      source: 'thought',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal surrounded by triage/classification language',
      text: 'After triage and classification of the failures, the linting errors are a separate concern from the refactor we shipped.',
      source: 'response',
      expect: ['separate concern']
    },
    {
      name: 'detects dismissal with "legacy" and "resolved" in normal reasoning',
      text: 'The legacy integration tests have been resolved by another team. These failures are pre-existing and someone else owns the fix.',
      source: 'response',
      expect: ['pre-existing']
    },
    {
      name: 'detects dismissal when agent handles/triages/finds issues normally',
      text: 'I handled the first finding by fixing the import. The remaining 3 failures are not related to our changes — they were triggered by a dependency update.',
      source: 'response',
      expect: ['not related to our']
    }
  ];

  for (const c of cases) {
    it(c.name, function run() {
      const hits = detect(c.text, c.source);

      if (c.expect === null) {
        expect(hits).toStrictEqual([]);
        return;
      }

      expect(hits.length).toBeGreaterThanOrEqual(c.expect.length);

      for (const phrase of c.expect) {
        expect(hits).toContainEqual(expect.objectContaining({ phrase }));
      }
    });
  }
});

describe('finding identity', function identity() {
  it('produces a 16-character hex string', function hex() {
    const finding = { kind: 'dismissive', source: 'response', phrase: 'test', snippet: 'test context' };
    const id = fingerprint(finding);

    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces different IDs for different kinds', function kinds() {
    const a = fingerprint({ kind: 'dismissive', source: 'response', phrase: 'test', snippet: 'ctx' });
    const b = fingerprint({ kind: 'verification', command: 'test', cwd: '/', failureType: 'error', error: 'fail' });

    expect(a).not.toBe(b);
  });

  it('produces consistent IDs for verification findings', function verificationId() {
    const input = { cwd: '/project', tool_use_id: 'abc' };
    const a = verification(input, 'bin/onboard test', 'non_zero_exit', 'exited 1');
    const b = verification(input, 'bin/onboard test', 'non_zero_exit', 'exited 1');

    expect(a.id).toBe(b.id);
  });
});

describe('legacy state migration', function legacy() {
  it('converts old hits array to finding records', function hits() {
    const state = {
      dismissive: true,
      hits: [{ source: 'response', phrase: 'pre-existing', offset: 10, snippet: 'test snippet' }]
    };
    const findings = migrate(state);

    expect(findings).toHaveLength(1);
    expect(findings[0].legacy).toBe(true);
    expect(findings[0].kind).toBe('dismissive');
    expect(findings[0].id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('converts old phrases-only state', function phrases() {
    const state = { dismissive: true, phrases: ['separate concern', 'out of scope'] };
    const findings = migrate(state);

    expect(findings).toHaveLength(2);
    expect(findings[0].legacy).toBe(true);
    expect(findings[0].snippet).toContain('legacy');
  });

  it('converts old failures array', function failures() {
    const state = {
      unresolved: true,
      failures: [
        {
          command: 'bin/onboard test',
          cwd: '/project',
          toolUseId: 'abc',
          failureType: 'non_zero_exit',
          error: 'exited 1'
        }
      ]
    };
    const findings = migrate(state);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('verification');
    expect(findings[0].legacy).toBe(true);
  });

  it('converts flat verification state without failures array', function flat() {
    const state = {
      unresolved: true,
      command: 'bin/onboard test',
      failureType: 'non_zero_exit',
      error: 'exited 1'
    };
    const findings = migrate(state);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('verification');
  });

  it('returns empty for null state', function empty() {
    expect(migrate(null)).toStrictEqual([]);
  });

  it('fills safe defaults for incomplete historic records', function incomplete() {
    const [hit, failure] = migrate({
      hits: [{ phrase: 'out of scope' }],
      failures: [{ command: 'bin/onboard test' }]
    });
    const [flat] = migrate({ unresolved: true, command: 'bin/onboard build' });

    expect(hit).toMatchObject({ source: 'response', offset: 0, legacy: true });
    expect(hit.snippet).toContain('legacy');
    expect(failure).toMatchObject({ cwd: '', toolUseId: '', legacy: true });
    expect(flat).toMatchObject({ failureType: 'error', error: 'unknown verification failure', legacy: true });
  });
});

describe('finding defaults', function findingDefaults() {
  it('uses default candidate and analytical settings when callers omit configuration', function omittedConfig() {
    expect(candidates('This is out of scope.', 'response').map(function phrase(hit) { return hit.phrase; })).toContain('out of scope');
    expect(analytical('This is out of scope.', 8, 'out of scope'.length)).toBe(false);
    expect(fingerprint({ source: 'response', phrase: 'x' })).toMatch(/^[a-f0-9]{16}$/);
  });

  it('does not flag a partial meta-token match below a configured threshold', function partialMeta() {
    const text = 'Campsite notes say this is a separate concern.';
    const offset = text.indexOf('separate concern');
    expect(analytical(text, offset, 'separate concern'.length, {
      metaTokens: ['campsite', 'detection'], metaTokenThreshold: 2, metaParagraphFallback: 80
    })).toBe(false);
  });

  it('orders equal-span candidates deterministically and handles a paragraph after the match', function tieAndParagraph() {
    expect(candidates('foo', 'response', { phrases: ['foo', 'Foo'] })).toHaveLength(1);
    const text = 'This is a separate concern.\n\nThe next paragraph is ordinary.';
    expect(analytical(text, text.indexOf('separate concern'), 'separate concern'.length, {
      metaTokens: [], metaTokenThreshold: 1, metaParagraphFallback: 80
    })).toBe(false);
  });
});

describe('ledger defaults', function ledgerDefaults() {
  it('constructs with default options and keeps duplicate findings idempotent', async function defaultsAndDuplicateRecord() {
    const defaultLedger = new ResolutionLedger(tempDir);
    expect(defaultLedger.path).toContain('ledger.json');
    expect(() => new ResolutionLedger(tempDir, { ledger: { baseDir: tempDir, fileName: '.' } })).toThrow(/file name/);

    const ledger = new ResolutionLedger(tempDir, {
      ledger: { baseDir: tempDir, fileName: 'direct-ledger.json' },
      resolve: { evidencePatterns: { generic: ['https?://'] } }
    });
    await ledger.record('same', { id: 'same', kind: 'dismissive' });
    await ledger.record('same', { id: 'same', kind: 'dismissive' });
    expect(await ledger.all()).toHaveLength(1);
    await expect(ledger.validate({
      classification: 'triaged', evidence: 'https://example.test/issues/42', model: null, effort: null, session: null,
      subject: null, relatedFindingId: null, verificationCommand: null, verificationEvidence: null, testEvidence: null
    })).resolves.toMatchObject({ model: null, effort: null, session: null });
  });
});

describe('CampsiteEngine', function engine() {
  it('starts clean by removing stale state', async function start() {
    await writeFile(statePath, '{}');
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await eng.start();

    let exists = true;

    try {
      await readFile(statePath);
    } catch {
      exists = false;
    }

    expect(exists).toBe(false);
  });

  it('observes dismissive text and persists findings', async function observe() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern.', 'response');

    expect(hits.length).toBeGreaterThanOrEqual(1);

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.findings).toContainEqual(
      expect.objectContaining({
        kind: 'dismissive',
        phrase: 'separate concern'
      })
    );
  });

  it('records verification failures', async function fail() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail(
      { cwd: '/project', tool_use_id: 'abc' },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );

    expect(finding.kind).toBe('verification');

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.findings).toContainEqual(
      expect.objectContaining({
        kind: 'verification',
        command: 'bin/onboard test'
      })
    );
  });

  it('clears matching verification findings after a passing rerun', async function pass() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });

    await eng.fail({ cwd: '/', tool_use_id: 'a' }, 'bin/onboard test', 'non_zero_exit', 'exited 1');
    await eng.pass('bin/onboard test');

    const active = await eng.active();
    expect(
      active.filter(function v(f) {
        return f.kind === 'verification';
      })
    ).toHaveLength(0);
  });

  it('preserves dismissive findings while clearing matching verification reruns', async function preserve() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });

    await eng.observe('This is a separate concern.', 'response');
    await eng.fail({ cwd: '/', tool_use_id: 'a' }, 'bin/onboard test', 'non_zero_exit', 'exited 1');
    await eng.pass('bin/onboard test');

    const active = await eng.active();
    expect(
      active.some(function d(f) {
        return f.kind === 'dismissive';
      })
    ).toBe(true);
    expect(
      active.some(function v(f) {
        return f.kind === 'verification';
      })
    ).toBe(false);
  });

  it('deduplicates identical findings', async function dedup() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });

    await eng.observe('This is a separate concern.', 'response');
    await eng.observe('This is a separate concern.', 'response');

    const active = await eng.active();
    const concerns = active.filter(function c(f) {
      return f.phrase === 'separate concern';
    });

    expect(concerns).toHaveLength(1);
  });

  it('formats followup message with finding IDs and resolve command', async function format() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern.', 'response');

    const message = await eng.format();

    expect(message).toContain('Campsite hook flagged');
    expect(message).toContain('Dismissive language detected');
    expect(message).toContain('separate concern');
    expect(message).toContain('campsite-rule/SKILL.md');
    expect(message).toContain('findingId');
    expect(message).toContain(`[${hits[0].id}]`);
    expect(message).toMatch(/\[[a-f0-9]{16}\] agent response/);
    expect(message).toContain('fixed');
    expect(message).toContain('triaged');
    expect(message).toContain('false-positive');
    expect(message).toContain('bypassed');
    expect(message).not.toContain('self-reported `model` and `effort`');
    expect(message).toContain('Fixing the discovered issue is the priority');
    expect(message).toContain('Do not rely on who changed it or when it changed');
  });

  it('returns null from format when all findings are resolved', async function resolved() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('resolved.md');

    for (const hit of hits) {
      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hit.id, fixedProof({ evidence }));
    }

    const message = await eng.format();
    expect(message).toBeNull();
  });

  it('evicts resolved findings from the session state file', async function evict() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern and out of scope.', 'response');
    const evidence = await artifact('evict.md');

    expect(hits.length).toBeGreaterThanOrEqual(2);

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
    await eng.resolve(hits[0].id, fixedProof({ evidence }));

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const remaining = state.findings.map(function id(f) {
      return f.id;
    });

    expect(remaining).not.toContain(hits[0].id);
    expect(remaining).toContain(hits[1].id);
  });

  it('removes state file when last finding is evicted', async function evictLast() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('evict-last.md');

    for (const hit of hits) {
      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hit.id, fixedProof({ evidence }));
    }

    let exists = true;

    try {
      await readFile(statePath);
    } catch {
      exists = false;
    }

    expect(exists).toBe(false);
  });

  it('migrates legacy state on first load', async function legacyLoad() {
    await writeFile(
      statePath,
      JSON.stringify({
        dismissive: true,
        phrases: ['pre-existing'],
        hits: [{ source: 'response', phrase: 'pre-existing', offset: 0, snippet: 'old snippet' }],
        unresolved: true,
        failures: [
          {
            command: 'bin/onboard test',
            cwd: '/project',
            toolUseId: 'a',
            failureType: 'non_zero_exit',
            error: 'exited 1'
          }
        ]
      })
    );

    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const active = await eng.active();

    expect(active).toHaveLength(2);
    expect(
      active.every(function l(f) {
        return f.legacy === true;
      })
    ).toBe(true);
  });

  it('handles null state path gracefully', async function nullPath() {
    const eng = new CampsiteEngine({ statePath: null, repo: tempDir });

    await eng.observe('This is out of scope.', 'response');
    const active = await eng.active();
    const message = await eng.format();

    expect(active).toStrictEqual([]);
    expect(message).toBeNull();
  });
});

describe('resolution ledger', function ledger() {
  it('handles no-session state, start cleanup, and selective verification-pass clearing', async function lifecycleEdges() {
    expect(CampsiteEngine.resolve({})).toBeNull();
    expect(CampsiteEngine.resolve({ session_id: 'unsafe / id' }, { directory: tempDir, filePrefix: 'rule-' })).toBe(
      join(tempDir, 'rule-unsafe---id.json')
    );

    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await writeFile(statePath, JSON.stringify({ findings: [{ id: 'stale' }] }), 'utf8');
    await eng.start();
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();

    await eng.fail({}, 'bin/onboard test-a', 'non_zero_exit', 'failed');
    await eng.fail({}, 'bin/onboard test-b', 'non_zero_exit', 'failed');
    await eng.pass('bin/onboard test-never-ran');
    expect((await eng.active()).length).toBe(2);
    await eng.pass('bin/onboard test-a');
    expect((await eng.active()).length).toBe(1);
    await eng.pass();
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();

    const ephemeral = new CampsiteEngine({ statePath: null, repo: tempDir });
    await ephemeral.start();
    await ephemeral.pass();
  });

  it('uses formatting fallbacks when a minimal format config omits optional labels and paths', async function formatFallbacks() {
    const config = { ...defaults(), format: { stopIntro: null } };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    await eng.observe('This is a separate concern.', 'response');

    const message = await eng.format();
    expect(message).toContain('Campsite hook flagged 1 concrete issue');
    expect(message).toContain('agent response');
    expect(message).toContain('.agents/skills/campsite-rule/SKILL.md');
  });

  it('pluralizes a stop prompt for multiple unresolved findings', async function pluralFormat() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await eng.observe('This is a separate concern.', 'response');
    await eng.observe('This is an unrelated issue.', 'response');
    expect(await eng.format()).toContain('2 concrete issues');
  });

  it('uses default state path settings and excludes directly proven findings from active work', async function defaultsAndDirectProof() {
    expect(CampsiteEngine.resolve({ session_id: 'default-session' })).toContain('campsite-default-session.json');
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    expect(eng.config).toBeDefined();
    const [finding] = await eng.observe('This is a separate concern.', 'response');
    await eng.ledger.prove(finding.id, {
      classification: 'fixed', evidence: 'https://example.test/pull/42', model: 'luna', effort: 'low'
    });
    expect(await eng.active()).toStrictEqual([]);
  });

  it('rejects unknown or already-resolved finding ids', async function resolveEdges() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const evidence = await artifact('resolve-edge.md');
    await expect(eng.resolve('missing', fixedProof({ evidence }))).rejects.toThrow(/finding not found/);

    const [finding] = await eng.observe('This is a separate concern.', 'response');
    await eng.resolve(finding.id, fixedProof({ evidence }));
    await expect(eng.resolve(finding.id, fixedProof({ evidence }))).rejects.toThrow(/already resolved/);
  });

  it('requires hook-produced verification evidence after artifact registration begins', async function provenanceEdge() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail({}, 'bin/onboard test', 'non_zero_exit', 'failed');
    const evidence = await artifact('provenance-edge.md');
    const verificationEvidence = await rerun({ name: 'provenance-edge-rerun.json' });
    await eng.register(join(tempDir, 'different-hook-artifact.json'));

    await expect(eng.resolve(finding.id, fixedProof({
      evidence,
      verificationCommand: 'bin/onboard test',
      verificationEvidence
    }))).rejects.toThrow(/not produced by the hook pipeline/);
  });

  it('allows a non-verification resolution after hook artifacts are registered', async function provenanceWithoutVerificationArtifact() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [finding] = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('provenance-no-verification.md');
    await eng.register(join(tempDir, 'registered-hook-artifact.json'));

    await eng.resolve(finding.id, fixedProof({ evidence }));
    expect(await eng.ledger.proven(finding.id)).not.toBeNull();
  });

  it('records finding context at detection time and merges proof at resolution', async function prove() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is out of scope.', 'response');
    const evidence = await artifact('proof.md');

    const before = await eng.ledger.lookup(hits[0].id);
    expect(before).not.toBeNull();
    expect(before.finding.kind).toBe('dismissive');
    expect(before.finding.id).toBe(hits[0].id);
    expect(before.finding.source).toBe('response');
    expect(before.finding.phrase).toBe('out of scope');
    expect(before.finding.snippet).toContain('out of scope');
    expect(before.finding.context).toContain('This is out of scope.');
    expect(before.classification).toBeNull();

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
    await eng.resolve(hits[0].id, {
      classification: 'fixed',
      evidence,
      subject: 'policy-docs',
      model: 'claude-opus-4.6',
      effort: 'high',
      session: 'test-session-abc'
    });

    const after = await eng.ledger.proven(hits[0].id);
    expect(after).not.toBeNull();
    expect(after.id).toBe(hits[0].id);
    expect(after.classification).toBe('fixed');
    expect(after.evidence).toBe(evidence);
    expect(after.subject).toBe('policy-docs');
    expect(after.model).toBe('claude-opus-4.6');
    expect(after.effort).toBe('high');
    expect(after.session).toBe('test-session-abc');
    expect(after.discovered).toBeTypeOf('number');
    expect(after.resolved).toBeTypeOf('number');
    expect(after.finding.kind).toBe('dismissive');
    expect(after.finding.id).toBe(hits[0].id);
    expect(after.finding.phrase).toBe('out of scope');
    expect(after.finding.context).toContain('This is out of scope.');
  });

  it('returns null for unproven findings', async function unproven() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const proof = await eng.ledger.proven('nonexistent');

    expect(proof).toBeNull();
  });

  it('subtracts proven findings from active list', async function subtract() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const evidence = await artifact('subtract.md');

    await eng.observe('This is out of scope.', 'response');
    await eng.observe('This is a separate concern and not part of this.', 'response');

    const before = await eng.active();
    expect(before.length).toBeGreaterThanOrEqual(2);

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
    await eng.resolve(before[0].id, fixedProof({ evidence }));

    const after = await eng.active();
    expect(after.length).toBe(before.length - 1);
  });

  it('preserves finding context when resolved from a different engine instance', async function crossSession() {
    const detector = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await detector.observe('This is out of scope.', 'response');

    const resolver = new CampsiteEngine({ statePath: null, repo: tempDir });
    const evidence = `${statePath} quoted false-positive in adapter discussion`;

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
    await resolver.resolve(hits[0].id, {
      classification: 'false-positive',
      evidence,
      model: 'claude-opus-4.6',
      effort: 'high',
      session: 'other-session'
    });

    const proof = await resolver.ledger.proven(hits[0].id);
    expect(proof.finding.kind).toBe('dismissive');
    expect(proof.finding.phrase).toBe('out of scope');
    expect(proof.finding.context).toContain('This is out of scope.');
    expect(proof.classification).toBe('false-positive');
    expect(proof.evidence).toBe(evidence);
  });

  it('recovers an orphaned session-state finding missing from the ledger', async function orphanRecovery() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail({ tool_use_id: 'orphan-test' }, 'bin/onboard test', 'non_zero_exit', 'exit 1');

    const ledgerPath = eng.ledger.path;
    const raw = JSON.parse(await readFile(ledgerPath, 'utf8'));
    delete raw[finding.id];
    await writeFile(ledgerPath, JSON.stringify(raw, null, 2), 'utf8');

    const fresh = new CampsiteEngine({ statePath, repo: tempDir });
    const orphanCheck = await fresh.ledger.lookup(finding.id);
    expect(orphanCheck, 'ledger entry should be gone').toBeNull();

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(
      state.findings.some(function match(f) {
        return f.id === finding.id;
      })
    ).toBe(true);

    const evidence = await artifact('orphan-fix.md');
    const verificationEvidence = await rerun({ name: 'orphan-rerun.json' });

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async
    await fresh.resolve(finding.id, {
      classification: 'fixed',
      evidence,
      verificationCommand: 'bin/onboard test',
      verificationEvidence,
      model: 'claude-opus-4.6',
      effort: 'high'
    });

    const proof = await fresh.ledger.proven(finding.id);
    expect(proof).toBeDefined();
    expect(proof.classification).toBe('fixed');
  });

  it('accepts fixed resolution without model and effort by default', async function missingIdentity() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');
    const evidence = await artifact('identity.md');

    await eng.resolve(hit.id, {
      classification: 'fixed',
      evidence,
      subject: 'policy-docs'
    });

    const proof = await eng.ledger.proven(hit.id);
    expect(proof?.model).toBeNull();
    expect(proof?.effort).toBeNull();
  });

  it('rejects missing model when requireModel is enabled', async function optionalModel() {
    const config = {
      ...defaults(),
      resolve: {
        ...defaults().resolve,
        requireModel: true
      }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    const [hit] = await eng.observe('This is out of scope.', 'response');
    const evidence = await artifact('optional-model.md');

    await expect(
      eng.resolve(hit.id, {
        classification: 'fixed',
        evidence,
        subject: 'policy-docs',
        effort: 'high'
      })
    ).rejects.toThrow(/model/i);
  });

  it('rejects placeholder fixed evidence', async function placeholder() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');

    await expect(
      eng.resolve(
        hit.id,
        fixedProof({
          evidence: 'commit abc123'
        })
      )
    ).rejects.toThrow(/evidence/i);
  });

  it('accepts fixed proofs without a subject', async function subject() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');
    const evidence = await artifact('subject.md');

    await eng.resolve(hit.id, {
      classification: 'fixed',
      evidence
    });

    const proof = await eng.ledger.proven(hit.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.subject).toBeNull();
  });

  it('accepts verification fixes with artifact evidence only', async function verificationProof() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail(
      { cwd: '/project', tool_use_id: 'abc' },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('verification-fix.md');

    await eng.resolve(finding.id, fixedProof({ evidence }));

    const proof = await eng.ledger.proven(finding.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.verificationEvidence).toBeNull();
  });

  it('accepts verification fixes only when the same command has a passing proof artifact', async function verificationRerun() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail(
      { cwd: '/project', tool_use_id: 'abc' },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('verification-rerun.md');
    const verificationEvidence = await rerun({ name: 'verification-rerun.json' });

    await Promise.resolve(
      eng.resolve(finding.id, {
        classification: 'fixed',
        evidence,
        verificationCommand: 'bin/onboard test',
        verificationEvidence,
        model: 'claude-opus-4.6',
        effort: 'high'
      })
    );

    const proof = await eng.ledger.proven(finding.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.verificationCommand).toBe('bin/onboard test');
    expect(proof?.verificationEvidence).toBe(verificationEvidence);
  });

  it('preserves linked verification context when dismissive fixes provide it', async function linkDismissive() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const verificationFinding = await eng.fail(
      { cwd: '/project', tool_use_id: 'abc' },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('dismissive-link.md');

    const verificationEvidence = await rerun({ name: 'dismissive-rerun.json' });
    await Promise.resolve(
      eng.resolve(verificationFinding.id, {
        classification: 'fixed',
        evidence,
        verificationCommand: 'bin/onboard test',
        verificationEvidence,
        model: 'claude-opus-4.6',
        effort: 'high'
      })
    );

    await Promise.resolve(
      eng.resolve(
        dismissive.id,
        fixedProof({
          evidence,
          subject: 'verification',
          relatedFindingId: verificationFinding.id
        })
      )
    );

    const proof = await eng.ledger.proven(dismissive.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.subject).toBe('verification');
    expect(proof?.relatedFindingId).toBe(verificationFinding.id);
  });

  it('accepts dismissive verification fixes linked to false-positive verification findings', async function falsePositiveLink() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const verificationFinding = await eng.fail(
      { cwd: '/project', tool_use_id: 'abc' },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('dismissive-false-positive-link.md');

    await Promise.resolve(
      eng.resolve(verificationFinding.id, {
        classification: 'false-positive',
        evidence: `${evidence} quoted false-positive in verification transcript`,
        model: 'claude-opus-4.6',
        effort: 'high'
      })
    );

    await Promise.resolve(
      eng.resolve(
        dismissive.id,
        fixedProof({
          evidence,
          subject: 'verification',
          relatedFindingId: verificationFinding.id
        })
      )
    );

    const proof = await eng.ledger.proven(dismissive.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.subject).toBe('verification');
    expect(proof?.relatedFindingId).toBe(verificationFinding.id);
  });

  it('accepts dismissive implementation fixes without forcing regression evidence', async function implementationMissingRegression() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const evidence = await artifact('dismissive-implementation.md');
    const verificationEvidence = await rerun({ name: 'implementation-rerun.json' });

    await eng.resolve(
      dismissive.id,
      fixedProof({
        evidence,
        subject: 'implementation',
        verificationCommand: 'bin/onboard test',
        verificationEvidence
      })
    );

    const proof = await eng.ledger.proven(dismissive.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.testEvidence).toBeNull();
  });

  it('accepts triaged findings with bounded trace evidence', async function triaged() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is a separate concern.', 'response');

    await eng.resolve(hit.id, {
      classification: 'triaged',
      evidence: 'bin/onboard test timeout trace captured for user sequencing'
    });

    const proof = await eng.ledger.proven(hit.id);
    expect(proof?.classification).toBe('triaged');
  });

  it('accepts dismissive implementation fixes with regression and rerun proof', async function implementationProof() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const evidence = await artifact('dismissive-implementation-proof.md');
    const testEvidence = await artifact('dismissive-implementation.test.js');
    const verificationEvidence = await rerun({ name: 'implementation-proof-rerun.json' });

    await Promise.resolve(
      eng.resolve(
        dismissive.id,
        fixedProof({
          evidence,
          subject: 'implementation',
          testEvidence,
          verificationCommand: 'bin/onboard test',
          verificationEvidence
        })
      )
    );

    const proof = await eng.ledger.proven(dismissive.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.subject).toBe('implementation');
    expect(proof?.testEvidence).toBe(testEvidence);
    expect(proof?.verificationCommand).toBe('bin/onboard test');
    expect(proof?.verificationEvidence).toBe(verificationEvidence);
  });

  it('rejects dismissive implementation fixes when testEvidence is not a test file', async function implementationArtifactKind() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const evidence = await artifact('dismissive-implementation-kind.md');
    const testEvidence = await artifact('dismissive-implementation-proof.md');
    const verificationEvidence = await rerun({ name: 'implementation-kind-rerun.json' });

    await expect(
      eng.resolve(
        dismissive.id,
        fixedProof({
          evidence,
          subject: 'implementation',
          testEvidence,
          verificationCommand: 'bin/onboard test',
          verificationEvidence
        })
      )
    ).rejects.toThrow(/testEvidence|regression test/i);
  });

  it('rejects policy-doc fixes that point to non-document artifacts', async function policyArtifactKind() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('That Docker failure is unrelated to our changes.', 'response');
    const evidence = await artifact('policy-proof.js');

    await expect(
      eng.resolve(
        dismissive.id,
        fixedProof({
          evidence,
          subject: 'policy-docs'
        })
      )
    ).rejects.toThrow(/policy-docs|documentation/i);
  });

  it('rejects false-positive evidence without filter reference', async function falsePositive() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');

    await expect(
      eng.resolve(hit.id, {
        classification: 'false-positive',
        evidence: '/tmp/proof.txt artifact exists but says nothing useful',
        model: 'claude-opus-4.6',
        effort: 'high'
      })
    ).rejects.toThrow(/false-positive|quoted|meta|fenced/i);
  });

  it('rejects bypassed evidence without condition descriptor', async function bypassed() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');

    await expect(
      eng.resolve(hit.id, {
        classification: 'bypassed',
        evidence: `${statePath} blocked for later handoff`,
        model: 'claude-opus-4.6',
        effort: 'high'
      })
    ).rejects.toThrow(/bypassed|outage|timeout|external/i);
  });

  it('enforces the public proof-field contract before a resolution is persisted', async function proofFields() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const valid = {
      classification: 'triaged',
      evidence: 'https://example.test/issues/42',
      model: 'luna',
      effort: 'low',
      session: 'ses_1'
    };

    await expect(eng.ledger.validate(valid)).resolves.toMatchObject({
      classification: 'triaged',
      evidence: valid.evidence,
      model: 'luna',
      effort: 'low',
      session: 'ses_1'
    });
    await expect(eng.ledger.validate({})).rejects.toThrow(/missing proof field/);
    await expect(eng.ledger.validate({ classification: 1, evidence: valid.evidence })).rejects.toThrow(/classification/);
    await expect(eng.ledger.validate({ classification: 'triaged', evidence: 1 })).rejects.toThrow(/evidence/);
    await expect(eng.ledger.validate({ ...valid, session: 1 })).rejects.toThrow(/session/);
    await expect(eng.ledger.validate({ ...valid, model: 1 })).rejects.toThrow(/model/);
    await expect(eng.ledger.validate({ ...valid, effort: 1 })).rejects.toThrow(/effort/);
    await expect(eng.ledger.validate({ ...valid, subject: 1 })).rejects.toThrow(/subject/);
    await expect(eng.ledger.validate({ ...valid, unexpected: true })).rejects.toThrow(/unknown proof field/);
    await expect(eng.ledger.validate({ ...valid, classification: 'unknown' })).rejects.toThrow(/invalid classification/);
    await expect(eng.ledger.validate({ ...valid, evidence: 'short' })).rejects.toThrow(/too short/);
  });

  it('requires a concrete model and effort when the configured policy asks for them', async function requiredModelAndEffort() {
    const config = {
      ...defaults(),
      resolve: {
        ...defaults().resolve,
        requireModel: true,
        requireEffort: true,
        minModelLength: 5
      }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    const base = { classification: 'triaged', evidence: 'https://example.test/issues/42' };

    await expect(eng.ledger.validate(base)).rejects.toThrow(/missing proof field.*model.*effort/);
    await expect(eng.ledger.validate({ ...base, model: 'ai', effort: 'low' })).rejects.toThrow(/invalid model identity/);
    await expect(eng.ledger.validate({ ...base, model: 'luna-1', effort: '' })).rejects.toThrow(/missing reasoning effort/);
    await expect(eng.ledger.validate({ ...base, model: 'luna-1', effort: 'low' })).resolves.toMatchObject({
      model: 'luna-1', effort: 'low'
    });
  });

  it('accepts a fixed URL proof and persists its signed ledger entry', async function fixedUrlProof() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });

    await eng.ledger.prove('url-proof', {
      classification: 'fixed',
      evidence: 'https://example.test/pull/42',
      model: 'luna',
      effort: 'low'
    });

    expect(await eng.ledger.proven('url-proof')).toMatchObject({
      classification: 'fixed',
      evidence: 'https://example.test/pull/42'
    });
  });

  it('accepts every documented terminal verification-artifact shape', async function terminalArtifacts() {
    const artifacts = [
      { name: 'terminal-last.txt', text: 'last_command: "bin/onboard test"\nlast_exit_code: 0\n' },
      { name: 'terminal-command.txt', text: 'command: bin/onboard test\nexit_code: 0\n' },
      { name: 'terminal-direct.json', text: JSON.stringify({ command: 'bin/onboard test', exit_code: '0' }) },
      { name: 'terminal-tool-input.json', text: JSON.stringify({ toolInput: { command: 'bin/onboard test' }, tool_output: { lastExitCode: 0 } }) },
      { name: 'terminal-output.json', text: JSON.stringify({ last_command: 'bin/onboard test', tool_output: 'exit_code: 0' }) }
    ];

    for (const [index, fixture] of artifacts.entries()) {
      const eng = new CampsiteEngine({ statePath: join(tempDir, `state-${index}.json`), repo: tempDir });
      const command = `bin/onboard test-${index}`;
      const finding = await eng.fail({ tool_use_id: `tool-${index}` }, command, 'non_zero_exit', 'failed');
      const evidence = await artifact(`terminal-fix-${index}.md`);
      const verificationEvidence = join(tempDir, fixture.name);
      await writeFile(verificationEvidence, fixture.text.replaceAll('bin/onboard test', command), 'utf8');

      await eng.resolve(finding.id, fixedProof({
        evidence,
        subject: 'verification',
        verificationCommand: command,
        verificationEvidence
      }));

      expect(await eng.ledger.proven(finding.id)).toMatchObject({ verificationEvidence });
    }
  });

  it('accepts policy and regression-test URL evidence on dismissive findings', async function urlEvidenceKinds() {
    const policy = new CampsiteEngine({ statePath, repo: tempDir });
    const [policyFinding] = await policy.observe('This is a separate concern.', 'response');
    await policy.resolve(policyFinding.id, fixedProof({
      evidence: 'https://example.test/skills/SKILL.md',
      subject: 'policy-docs'
    }));

    const implementation = new CampsiteEngine({ statePath: join(tempDir, 'implementation.json'), repo: tempDir });
    const [implementationFinding] = await implementation.observe('This is an unrelated issue.', 'response');
    await implementation.resolve(implementationFinding.id, fixedProof({
      evidence: 'https://example.test/changes/fix.md',
      subject: 'implementation',
      testEvidence: 'https://example.test/test/widget.test.js'
    }));

    expect(await policy.ledger.proven(policyFinding.id)).not.toBeNull();
    expect(await implementation.ledger.proven(implementationFinding.id)).not.toBeNull();
  });

  it('rejects incomplete and contradictory verification proof artifacts', async function verificationProofFailures() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail({}, 'bin/onboard test', 'non_zero_exit', 'failed');
    const evidence = await artifact('verification-proof-failure.md');
    const passing = await rerun({ name: 'passing-proof.json' });
    const noCommand = join(tempDir, 'no-command.txt');
    const wrongCommand = await rerun({ name: 'wrong-command.json', command: 'bin/onboard build' });
    const nonZero = await rerun({ name: 'nonzero.json', exitCode: 2 });
    await writeFile(noCommand, 'exit_code: 0\n', 'utf8');

    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationEvidence: passing }))).rejects.toThrow(/verificationCommand/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard test' }))).rejects.toThrow(/verificationEvidence/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard build', verificationEvidence: passing }))).rejects.toThrow(/must match finding command/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard test', verificationEvidence: join(tempDir, 'missing.json') }))).rejects.toThrow(/file not found/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard test', verificationEvidence: noCommand }))).rejects.toThrow(/must include a command/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard test', verificationEvidence: wrongCommand }))).rejects.toThrow(/same command/);
    await expect(eng.resolve(finding.id, fixedProof({ evidence, verificationCommand: 'bin/onboard test', verificationEvidence: nonZero }))).rejects.toThrow(/exit code 0/);
  });

  it('rejects a nonexistent commit cited as fixed evidence', async function missingCommit() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await expect(eng.ledger.validate({ classification: 'fixed', evidence: 'deadbeefcafe' })).rejects.toThrow(/commit SHA not found/);
  });

  it('rejects invalid fixed-proof subjects and unresolved or mismatched related findings', async function relatedProofFailures() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [dismissive] = await eng.observe('This is a separate concern.', 'response');
    const relatedDismissive = (await eng.observe('This is an unrelated issue.', 'response'))[0];
    const unresolvedVerification = await eng.fail({}, 'bin/onboard test', 'non_zero_exit', 'failed');
    const evidence = await artifact('related-proof-failure.md');

    await expect(eng.resolve(dismissive.id, fixedProof({ evidence, subject: 'not-a-subject' }))).rejects.toThrow(/invalid subject/);
    await expect(eng.resolve(dismissive.id, fixedProof({ evidence, subject: 'verification', relatedFindingId: dismissive.id }))).rejects.toThrow(/different finding/);
    await expect(eng.resolve(dismissive.id, fixedProof({ evidence, subject: 'verification', relatedFindingId: 'missing' }))).rejects.toThrow(/not found/);
    await expect(eng.resolve(dismissive.id, fixedProof({ evidence, subject: 'verification', relatedFindingId: relatedDismissive.id }))).rejects.toThrow(/verification finding/);
    await expect(eng.resolve(dismissive.id, fixedProof({ evidence, subject: 'verification', relatedFindingId: unresolvedVerification.id }))).rejects.toThrow(/resolved verification finding/);
  });

  it('does not treat arbitrary URL evidence as policy or regression-test proof', async function invalidUrlEvidenceKinds() {
    const policy = new CampsiteEngine({ statePath, repo: tempDir });
    const [policyFinding] = await policy.observe('This is a separate concern.', 'response');
    await expect(policy.resolve(policyFinding.id, fixedProof({
      evidence: 'https://example.test/changes/fix.js', subject: 'policy-docs'
    }))).rejects.toThrow(/policy-docs evidence/);

    const implementation = new CampsiteEngine({ statePath: join(tempDir, 'invalid-url-implementation.json'), repo: tempDir });
    const [implementationFinding] = await implementation.observe('This is an unrelated issue.', 'response');
    await expect(implementation.resolve(implementationFinding.id, fixedProof({
      evidence: 'https://example.test/changes/fix.md',
      subject: 'implementation',
      testEvidence: 'https://example.test/changes/fix.js'
    }))).rejects.toThrow(/regression test surface/);
  });

  it('rejects identical evidence only when a bulk threshold is configured', async function bulk() {
    const config = {
      ...defaults(),
      resolve: {
        ...defaults().resolve,
        maxIdenticalEvidence: 2
      }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    const evidence = await artifact('bulk.md');

    await eng.observe('This is out of scope.', 'response');
    await eng.observe('This is a separate concern.', 'response');
    await eng.observe('This is not part of this task.', 'response');

    const active = await eng.active();

    await Promise.resolve(eng.resolve(active[0].id, fixedProof({ evidence })));
    await Promise.resolve(eng.resolve(active[1].id, fixedProof({ evidence })));

    await expect(eng.resolve(active[2].id, fixedProof({ evidence }))).rejects.toThrow(/identical evidence|bulk/i);
  });

  it('accepts repo-root filename evidence for fixed proofs', async function repoRootFile() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is out of scope.', 'response');

    const evidence = 'README.md policy artifact';
    await writeFile(join(tempDir, 'README.md'), '# artifact\n');
    await Promise.resolve(eng.resolve(hit.id, fixedProof({ evidence })));

    const proof = await eng.ledger.proven(hit.id);
    expect(proof?.classification).toBe('fixed');
    expect(proof?.evidence).toBe(evidence);
  });

  it('escalates repeated stop prompts for the same unresolved finding', async function escalation() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await eng.observe('This is out of scope.', 'response');

    const first = await eng.format();
    const second = await eng.format();
    const third = await eng.format();

    expect(first).not.toContain('previously flagged');
    expect(second).toContain('previously flagged and remains unresolved');
    expect(third).toContain('flagged 3 times');
  });

  describe('ledger HMAC integrity', function integrity() {
    it('stores integrity field on proven entries', async function storesIntegrity() {
      const eng = new CampsiteEngine({ statePath, repo: tempDir });
      const hits = await eng.observe('This is a separate concern.', 'response');

      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hits[0].id, fixedProof({ evidence: await artifact('hmac.md') }));

      const data = JSON.parse(await readFile(eng.ledger.path, 'utf8'));
      const entry = data[hits[0].id];

      expect(entry).toBeDefined();
      expect(entry.integrity).not.toBeNull();
      expect(entry.integrity).toMatch(/^[0-9a-f]+$/i);
    });

    it('accepts entries with valid HMAC', async function acceptsValidHmac() {
      const eng = new CampsiteEngine({ statePath, repo: tempDir });
      const hits = await eng.observe('This is a separate concern.', 'response');

      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hits[0].id, fixedProof({ evidence: await artifact('hmac-valid.md') }));

      const proof = await eng.ledger.proven(hits[0].id);

      expect(proof).not.toBeNull();
    });

    it('rejects entries with tampered classification', async function rejectsTamperedClassification() {
      const eng = new CampsiteEngine({ statePath, repo: tempDir });
      const hits = await eng.observe('This is a separate concern.', 'response');

      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hits[0].id, fixedProof({ evidence: await artifact('hmac-classification.md') }));

      const data = JSON.parse(await readFile(eng.ledger.path, 'utf8'));
      data[hits[0].id].classification = 'false-positive';
      await writeFile(eng.ledger.path, JSON.stringify(data, null, 2), 'utf8');

      const eng2 = new CampsiteEngine({ statePath: join(tempDir, 'state2.json'), repo: tempDir });
      const proof = await eng2.ledger.proven(hits[0].id);

      expect(proof).toBeNull();
    });

    it('rejects entries with tampered evidence', async function rejectsTamperedEvidence() {
      const eng = new CampsiteEngine({ statePath, repo: tempDir });
      const hits = await eng.observe('This is a separate concern.', 'response');

      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hits[0].id, fixedProof({ evidence: await artifact('hmac-evidence.md') }));

      const data = JSON.parse(await readFile(eng.ledger.path, 'utf8'));
      data[hits[0].id].evidence = '/tmp/tampered-evidence-path.md';
      await writeFile(eng.ledger.path, JSON.stringify(data, null, 2), 'utf8');

      const eng2 = new CampsiteEngine({ statePath: join(tempDir, 'state2.json'), repo: tempDir });
      const proof = await eng2.ledger.proven(hits[0].id);

      expect(proof).toBeNull();
    });

    it('rejects entries with missing integrity field', async function rejectsMissingIntegrity() {
      const eng = new CampsiteEngine({ statePath, repo: tempDir });
      const hits = await eng.observe('This is a separate concern.', 'response');

      // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async — biome can't trace through class private fields
      await eng.resolve(hits[0].id, fixedProof({ evidence: await artifact('hmac-missing.md') }));

      const data = JSON.parse(await readFile(eng.ledger.path, 'utf8'));
      delete data[hits[0].id].integrity;
      await writeFile(eng.ledger.path, JSON.stringify(data, null, 2), 'utf8');

      const eng2 = new CampsiteEngine({ statePath: join(tempDir, 'state2.json'), repo: tempDir });
      const proof = await eng2.ledger.proven(hits[0].id);

      expect(proof).toBeNull();
    });
  });
});

describe('config integration', function configSuite() {
  it('uses custom phrases from config for detection', async function phrases() {
    const config = {
      ...defaults(),
      detection: { ...defaults().detection, phrases: ['custom badword'] }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });

    await eng.observe('This has a custom badword in it.', 'response');
    const active = await eng.active();

    expect(active).toContainEqual(expect.objectContaining({ phrase: 'custom badword' }));
  });

  it('ignores default phrases when custom phrases replace them', async function override() {
    const config = {
      ...defaults(),
      detection: { ...defaults().detection, phrases: ['custom badword'] }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });

    await eng.observe('This is a separate concern.', 'response');
    const active = await eng.active();

    expect(active).toStrictEqual([]);
  });

  it('uses custom contextRadius for snapshot', async function contextRadius() {
    const config = {
      ...defaults(),
      snapshot: { contextRadius: 10, paragraphDelimiter: '\n\n' }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    const hits = await eng.observe('This is a separate concern from this work.', 'response');

    const entry = await eng.ledger.lookup(hits[0].id);

    expect(entry.finding.context).toBeDefined();
    expect(entry.finding.context.length).toBeLessThan(60);
  });

  it('captures previous and next paragraphs in ledger context', async function multiParagraph() {
    const text = [
      'I checked the test suite and found two failures.',
      '',
      'The Docker failure is not related to our changes.',
      '',
      'I will proceed with the remaining work.'
    ].join('\n');

    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe(text, 'response');

    const entry = await eng.ledger.lookup(hits[0].id);

    expect(entry.finding.context).toContain('checked the test suite');
    expect(entry.finding.context).toContain('not related to our changes');
    expect(entry.finding.context).toContain('proceed with the remaining work');
  });

  it('uses custom ledger directory', async function ledgerDir() {
    const customDir = join(tempDir, 'custom-ledger');
    const evidence = await artifact('custom-ledger.md');
    const config = {
      ...defaults(),
      ledger: { baseDir: customDir, fileName: 'proof.json' }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    const hits = await eng.observe('This is a separate concern.', 'response');

    // biome-ignore lint/nursery/useAwaitThenable: eng.resolve() is async
    await eng.resolve(hits[0].id, fixedProof({ evidence }));

    const proof = await eng.ledger.proven(hits[0].id);
    expect(proof).not.toBeNull();
    expect(proof.classification).toBe('fixed');
    expect((await stat(eng.ledger.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects ledger filenames that escape their repository-specific directory', function ledgerFileName() {
    expect(() => new CampsiteEngine({
      statePath,
      repo: tempDir,
      config: { ...defaults(), ledger: { baseDir: tempDir, fileName: '../outside.json' } }
    })).toThrow(/file name, not a path/);
  });

  it('uses custom format config in output', async function format() {
    const config = {
      ...defaults(),
      format: {
        ...defaults().format,
        stopIntro: '{count} finding{s} remain.',
        skillPath: 'custom/SKILL.md',
        resolveCli: 'custom-resolve'
      }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    await eng.observe('This is a separate concern.', 'response');

    const message = await eng.format();

    expect(message).toContain('1 finding remain.');
    expect(message).toContain('custom/SKILL.md');
    expect(message).toContain('custom-resolve');
  });

  it('uses custom source labels in format', async function labels() {
    const config = {
      ...defaults(),
      format: { ...defaults().format, sourceLabels: { response: 'bot reply', thought: 'bot thinking' } }
    };
    const eng = new CampsiteEngine({ statePath, repo: tempDir, config });
    await eng.observe('This is a separate concern.', 'response');

    const message = await eng.format();

    expect(message).toContain('bot reply');
  });

  it('resolves state path with custom prefix and directory', function stateResolve() {
    const stateConfig = { filePrefix: 'my-campsite-', directory: '/tmp/custom' };
    const path = CampsiteEngine.resolve({ session_id: 'abc123' }, stateConfig);

    expect(path).toContain('/tmp/custom/my-campsite-abc123.json');
  });
});

describe('defense layers', function defenseLayers() {
  it('persists nonce in session state', async function persistNonce() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });

    await eng.setNonce('test-nonce-123');

    const data = JSON.parse(await readFile(statePath, 'utf8'));
    expect(data.nonce).toBe('test-nonce-123');
  });

  it('rejects resolve when nonce is set but missing from proof', async function rejectMissingNonce() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('nonce-missing.md');

    await eng.setNonce('hook-nonce');

    await expect(eng.resolve(hit.id, fixedProof({ evidence }))).rejects.toThrow(
      'invalid or missing session nonce'
    );
  });

  it('rejects resolve when nonce is wrong', async function rejectWrongNonce() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('nonce-wrong.md');

    await eng.setNonce('real');

    await expect(
      eng.resolve(
        hit.id,
        fixedProof({
          evidence,
          nonce: 'fake'
        })
      )
    ).rejects.toThrow('invalid or missing session nonce');
  });

  it('rotates nonce after successful resolution', async function rotateNonce() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const hits = await eng.observe('This is a separate concern and out of scope.', 'response');
    const evidence = await artifact('nonce-rotate.md');

    expect(hits.length).toBeGreaterThanOrEqual(2);

    await eng.setNonce('before-rotate');

    await eng.resolve(
      hits[0].id,
      fixedProof({
        evidence,
        nonce: 'before-rotate'
      })
    );

    const data = JSON.parse(await readFile(statePath, 'utf8'));
    expect(data.nonce).not.toBe('before-rotate');
    expect(data.nonce).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows resolve when no nonce is set', async function resolveWithoutNonce() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const [hit] = await eng.observe('This is a separate concern.', 'response');
    const evidence = await artifact('no-nonce.md');

    await eng.resolve(hit.id, fixedProof({ evidence }));

    const proof = await eng.ledger.proven(hit.id);
    expect(proof?.classification).toBe('fixed');
  });

  it('registers and accepts hook-produced artifacts', async function registerAccepts() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    await eng.observe('This is a separate concern.', 'response');
    const finding = await eng.fail(
      { tool_input: { command: 'bin/onboard test' } },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('provenance-register-fix.md');
    const verificationEvidence = await rerun({ name: 'provenance-register-rerun.json' });

    await eng.register(verificationEvidence);
    expect(eng.registered(verificationEvidence)).toBe(true);

    await eng.resolve(finding.id, {
      ...fixedProof({
        evidence,
        subject: 'verification',
        verificationCommand: 'bin/onboard test',
        verificationEvidence
      })
    });

    const proof = await eng.ledger.proven(finding.id);
    expect(proof?.classification).toBe('fixed');
  });

  it('rejects unregistered verification evidence', async function rejectUnregisteredEvidence() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail(
      { tool_input: { command: 'bin/onboard test' } },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('provenance-reject-fix.md');
    const registeredPath = await rerun({ name: 'provenance-registered-only.json' });
    const otherEvidence = await rerun({ name: 'provenance-not-registered.json' });

    await eng.register(registeredPath);

    await expect(
      eng.resolve(finding.id, {
        ...fixedProof({
          evidence,
          subject: 'verification',
          verificationCommand: 'bin/onboard test',
          verificationEvidence: otherEvidence
        })
      })
    ).rejects.toThrow('verificationEvidence was not produced by the hook pipeline');
  });

  it('persists artifact registry in session state', async function persistArtifacts() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const artifactPath = await artifact('registry-persist.md');

    await eng.register(artifactPath);

    const data = JSON.parse(await readFile(statePath, 'utf8'));
    expect(data.artifacts).toContain(artifactPath);
  });

  it('skips provenance check when no artifacts are registered', async function skipProvenance() {
    const eng = new CampsiteEngine({ statePath, repo: tempDir });
    const finding = await eng.fail(
      { tool_input: { command: 'bin/onboard test' } },
      'bin/onboard test',
      'non_zero_exit',
      'verification exited 1'
    );
    const evidence = await artifact('provenance-skip-fix.md');
    const verificationEvidence = await rerun({ name: 'provenance-skip-rerun.json' });

    await eng.resolve(finding.id, {
      ...fixedProof({
        evidence,
        subject: 'verification',
        verificationCommand: 'bin/onboard test',
        verificationEvidence
      })
    });

    const proof = await eng.ledger.proven(finding.id);
    expect(proof?.classification).toBe('fixed');
  });

  it('preserves nonce and artifacts across load cycles', async function loadCycle() {
    const eng1 = new CampsiteEngine({ statePath, repo: tempDir });
    const artifactPath = await artifact('load-cycle.md');

    await eng1.setNonce('persisted-nonce');
    await eng1.register(artifactPath);

    const eng2 = new CampsiteEngine({ statePath, repo: tempDir });

    expect(await eng2.nonce()).toBe('persisted-nonce');
    expect(eng2.registered(artifactPath)).toBe(true);
  });
});
