/**
 * Integration tests for campsite-rule pressure scenarios.
 *
 * These committed JSON fixtures are the executable spec for when campsite
 * cleanup must trigger. The deterministic suite proves three things:
 * - each scenario fixture is well-formed
 * - each bundled sample response passes or fails the rubric honestly
 * - each referenced repo surface still contains the enforcement signals the
 *   skill depends on
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const fixtures = join(import.meta.dirname, 'fixtures');
const scenarios = await readScenarios();

/**
 * Read the committed scenario fixtures from disk so the suite's inventory stays
 * aligned with the skill-owned fixture directory.
 */
async function readScenarios() {
  const names = await readdir(fixtures);
  const files = names
    .filter(function json(name) {
      return name.endsWith('.json');
    })
    .sort();

  return Promise.all(
    files.map(async function entry(name) {
      const path = join(fixtures, name);
      const text = await readFile(path, 'utf8');
      return JSON.parse(text);
    })
  );
}

describe('fixture shape', function shape() {
  for (const scenario of scenarios) {
    it(`keeps ${scenario.id} well-formed`, function wellFormed() {
      expect(shapeFailures(scenario)).toStrictEqual([]);
    });
  }
});

describe('bundled response rubric', function rubric() {
  for (const scenario of scenarios) {
    it(`flags ${scenario.id}'s noncompliant sample as failing the rubric`, function reject() {
      expect(noncompliantFailures(scenario)).toStrictEqual([]);
    });

    it(`accepts ${scenario.id}'s compliant sample`, function accept() {
      expect(compliantFailures(scenario)).toStrictEqual([]);
    });
  }
});

describe('plugin-owned surface enforcement', function surfaces() {
  for (const scenario of scenarios) {
    it(`keeps ${scenario.id}'s enforcement signals intact`, async function intact() {
      expect(await surfaceFailures(scenario)).toStrictEqual([]);
    });
  }
});

/**
 * Validates that a scenario fixture has all required fields. The rubric is
 * the executable judgment spec — a missing rubric would let any response pass.
 */
function shapeFailures(scenario) {
  const failures = [];
  const fields = ['id', 'title', 'owner', 'summary', 'currentFailure'];

  for (const field of fields) {
    if (!scenario[field]) {
      failures.push(`${scenario.id ?? 'unknown'}: missing "${field}"`);
    }
  }

  if (!Array.isArray(scenario.surfaceChecks) || scenario.surfaceChecks.length === 0) {
    failures.push(`${scenario.id}: missing surface checks`);
  }

  if (!scenario.samples?.noncompliant || !scenario.samples?.compliant) {
    failures.push(`${scenario.id}: missing sample responses`);
  }

  if (!scenario.rubric || typeof scenario.rubric !== 'object') {
    failures.push(`${scenario.id}: missing rubric`);
  } else {
    for (const key of ['mustMention', 'mustNotMention', 'requireAction']) {
      if (scenario.rubric[key] !== undefined && !Array.isArray(scenario.rubric[key])) {
        failures.push(`${scenario.id}: rubric.${key} must be an array`);
      }
    }
  }

  return failures;
}

/**
 * Asserts the noncompliant sample does NOT satisfy the rubric. If it passes,
 * the rubric is too lenient or the sample is not actually noncompliant.
 */
function noncompliantFailures(scenario) {
  const failures = [];
  const result = judgeResponse(scenario, scenario.samples.noncompliant);

  if (result.ok) {
    failures.push(`${scenario.id}: noncompliant sample unexpectedly passed`);
  }

  return failures;
}

/**
 * Asserts the compliant sample satisfies the rubric. If it fails, the rubric
 * is too strict or the sample needs updating.
 */
function compliantFailures(scenario) {
  const result = judgeResponse(scenario, scenario.samples.compliant);

  if (result.ok) {
    return [];
  }

  return [`${scenario.id}: compliant sample failed (${formatFindings(result.findings)})`];
}

/**
 * Verifies each scenario's surface-check patterns still appear in the
 * referenced repo files. Catches drift when skills, hooks, or config evolve.
 */
async function surfaceFailures(scenario) {
  const failures = [];

  for (const check of scenario.surfaceChecks ?? []) {
    // Host-project surfaces (Cursor rules, a PR template, Grit policies) are installation concerns
    // outside this package. This suite can only truthfully assert sources this package owns.
    if (!check.path.startsWith('.agents/skills/campsite-rule/')) continue;
    const path = join(root, 'plugins', 'campsite-rule', check.path.slice('.agents/skills/campsite-rule/'.length));
    let text = '';

    try {
      text = await readFile(path, 'utf8');
    } catch {
      failures.push(`${scenario.id}: missing surface ${check.path}`);
      continue;
    }

    const body = normalize(text);

    for (const pattern of check.patterns ?? []) {
      if (!body.includes(normalize(pattern))) {
        failures.push(`${scenario.id}: ${check.path} missing pattern "${pattern}"`);
      }
    }
  }

  return failures;
}

/**
 * Applies the scenario's rubric (mustMention, mustNotMention, requireAction)
 * against a response body to determine pass/fail.
 */
function judgeResponse(scenario, text) {
  const body = normalize(text);
  const missing = [];
  const banned = [];
  const rubric = scenario.rubric ?? {};

  for (const pattern of rubric.mustMention ?? []) {
    if (!body.includes(normalize(pattern))) {
      missing.push(pattern);
    }
  }

  for (const pattern of rubric.mustNotMention ?? []) {
    if (body.includes(normalize(pattern))) {
      banned.push(pattern);
    }
  }

  const actions = rubric.requireAction ?? [];
  const acted = actions.some(function action(pattern) {
    return body.includes(normalize(pattern));
  });

  const findings = [];

  if (missing.length > 0) {
    findings.push(`missing ${missing.join(', ')}`);
  }

  if (banned.length > 0) {
    findings.push(`banned ${banned.join(', ')}`);
  }

  if (actions.length > 0 && !acted) {
    findings.push(`no action cue (${actions.join(', ')})`);
  }

  return {
    ok: findings.length === 0,
    findings
  };
}

/** Joins finding messages for human-readable assertion output. */
function formatFindings(findings) {
  return findings.join('; ');
}

/**
 * Normalizes text for case-insensitive, whitespace-agnostic comparisons.
 * Strips markdown styling (backticks, bold markers) so fixture patterns
 * match regardless of formatting changes.
 */
function normalize(text) {
  return (
    text
      .toLowerCase()
      // The fixtures care about documented intent, not markdown styling.
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
