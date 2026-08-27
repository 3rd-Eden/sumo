/**
 * Tests for campsite configuration discovery, merging, and defaults.
 *
 * @module config.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { defaults, load, resolve } from '../src/config.js';

let tempDir;

beforeEach(async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'campsite-config-'));
});

afterEach(async function cleanup() {
  await rm(tempDir, { recursive: true, force: true });
});

describe('defaults', function defaultsSuite() {
  it('returns a complete config with all sections', function complete() {
    const d = defaults();

    expect(d.detection).toBeDefined();
    expect(d.detection.phrases).toBeInstanceOf(Array);
    expect(d.detection.phrases.length).toBeGreaterThan(0);
    expect(d.detection.metaTokens).toBeInstanceOf(Array);
    expect(d.detection.metaTokenThreshold).toBe(1);
    expect(d.detection.snippetRadius).toBe(120);
    expect(d.detection.metaParagraphFallback).toBe(120);
    expect(d.detection.backtickScanRadius).toBe(200);
    expect(d.detection.quoteLookaround).toBe(4);

    expect(d.snapshot.contextRadius).toBe(500);
    expect(d.snapshot.paragraphDelimiter).toBe('\n\n');

    expect(d.ledger.baseDir).toBe(join(homedir(), '.local', 'share', 'campsite'));
    expect(d.ledger.fileName).toBe('ledger.json');

    expect(d.state.directory).toBeNull();
    expect(d.state.filePrefix).toBe('campsite-');

    expect(d.verification.patterns).toBeInstanceOf(Array);
    expect(d.verification.successExitCodes).toStrictEqual([0]);
    expect(d.verification.ignoredFailureTypes).toStrictEqual(['permission_denied']);

    expect(d.resolve.classifications).toStrictEqual(['fixed', 'triaged', 'false-positive', 'bypassed']);
    expect(d.resolve.minEvidenceLength).toBe(12);
    expect(d.resolve.maxIdenticalEvidence).toBeNull();
    expect(d.resolve.minModelLength).toBe(3);
    expect(d.resolve.requireModel).toBe(false);
    expect(d.resolve.requireEffort).toBe(false);
    expect(d.resolve.verifyArtifacts).toBe(true);
    expect(d.resolve.escalationThresholds).toStrictEqual([2, 3]);
    expect(d.resolve.evidencePatterns.generic).toBeInstanceOf(Array);
    expect(d.resolve.evidencePatterns.fixed).toBeInstanceOf(Array);
    expect(d.resolve.evidencePatterns.falsePositive).toBeInstanceOf(Array);
    expect(d.resolve.evidencePatterns.bypassed).toBeInstanceOf(Array);

    expect(d.format.skillPath).toContain('campsite-rule/SKILL.md');
    expect(d.format.resolveCli).toContain('hook.js');
    expect(d.format.sourceLabels.thought).toBe('agent thought');
    expect(d.format.sourceLabels.response).toBe('agent response');
  });

  it('returns a fresh object on each call', function fresh() {
    const a = defaults();
    const b = defaults();

    expect(a).not.toBe(b);
    expect(a).toStrictEqual(b);
  });
});

describe('load', function loadSuite() {
  it('finds campsite key in package.json', async function finds() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', campsite: { detection: { metaTokenThreshold: 5 } } })
    );

    const config = load(tempDir);

    expect(config).not.toBeNull();
    expect(config.detection.metaTokenThreshold).toBe(5);
  });

  it('walks up to ancestor package.json', async function ancestor() {
    const child = join(tempDir, 'a', 'b', 'c');
    await mkdir(child, { recursive: true });
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', campsite: { ledger: { fileName: 'custom.json' } } })
    );

    const config = load(child);

    expect(config).not.toBeNull();
    expect(config.ledger.fileName).toBe('custom.json');
  });

  it('returns null when no campsite key exists', async function missing() {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'bare' }));

    const config = load(tempDir);

    expect(config).toBeNull();
  });

  it('returns null when no package.json exists', function none() {
    const config = load(tempDir);

    expect(config).toBeNull();
  });

  it('picks the nearest ancestor with a campsite key', async function nearest() {
    const child = join(tempDir, 'nested');
    await mkdir(child, { recursive: true });

    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', campsite: { detection: { metaTokenThreshold: 1 } } })
    );
    await writeFile(
      join(child, 'package.json'),
      JSON.stringify({ name: 'nested', campsite: { detection: { metaTokenThreshold: 9 } } })
    );

    const config = load(child);

    expect(config.detection.metaTokenThreshold).toBe(9);
  });
});

describe('resolve', function resolveSuite() {
  it('deep-merges user config over defaults', async function merges() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        campsite: {
          detection: { metaTokenThreshold: 5 },
          ledger: { fileName: 'custom.json' },
          resolve: { maxIdenticalEvidence: 4 }
        }
      })
    );

    const config = resolve(tempDir);

    expect(config.detection.metaTokenThreshold).toBe(5);
    expect(config.detection.phrases.length).toBeGreaterThan(0);
    expect(config.detection.snippetRadius).toBe(120);
    expect(config.ledger.fileName).toBe('custom.json');
    expect(config.resolve.maxIdenticalEvidence).toBe(4);
    expect(config.resolve.classifications).toStrictEqual(['fixed', 'triaged', 'false-positive', 'bypassed']);
  });

  it('replaces arrays entirely instead of concatenating', async function arrays() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        campsite: {
          detection: { phrases: ['custom-phrase'] }
        }
      })
    );

    const config = resolve(tempDir);

    expect(config.detection.phrases).toStrictEqual(['custom-phrase']);
  });

  it('freezes the result deeply', async function frozen() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', campsite: { detection: { metaTokenThreshold: 3 } } })
    );

    const config = resolve(tempDir);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.detection)).toBe(true);
    expect(Object.isFrozen(config.detection.phrases)).toBe(true);
    expect(Object.isFrozen(config.ledger)).toBe(true);
    expect(Object.isFrozen(config.format)).toBe(true);
    expect(Object.isFrozen(config.format.sourceLabels)).toBe(true);
  });

  it('expands tilde in ledger.baseDir', async function tilde() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        campsite: { ledger: { baseDir: '~/custom-campsite' } }
      })
    );

    const config = resolve(tempDir);

    expect(config.ledger.baseDir).toBe(join(homedir(), 'custom-campsite'));
    expect(config.ledger.baseDir).not.toContain('~');
  });

  it('expands tilde in state.directory', async function stateTilde() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        campsite: { state: { directory: '~/campsite-state' } }
      })
    );

    const config = resolve(tempDir);

    expect(config.state.directory).toBe(join(homedir(), 'campsite-state'));
  });

  it('expands exact home-directory values in both configurable paths', async function exactTilde() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', campsite: { ledger: { baseDir: '~' }, state: { directory: '~' } } })
    );

    const config = resolve(tempDir);

    expect(config.ledger.baseDir).toBe(homedir());
    expect(config.state.directory).toBe(homedir());
  });

  it('returns frozen defaults when no campsite key exists', async function noKey() {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'bare' }));

    const config = resolve(tempDir);

    expect(Object.isFrozen(config)).toBe(true);
    expect(config.detection.snippetRadius).toBe(120);
    expect(config.ledger.baseDir).toBe(join(homedir(), '.local/share/campsite'));
    expect(config.resolve.maxIdenticalEvidence).toBeNull();
  });

  it('uses the process working directory when resolve receives no root', function implicitRoot() {
    expect(resolve()).toMatchObject({ detection: { metaTokenThreshold: 1 } });
  });

  it('replaces resolve arrays instead of concatenating', async function resolveArrays() {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        campsite: {
          resolve: {
            classifications: ['fixed']
          }
        }
      })
    );

    const config = resolve(tempDir);

    expect(config.resolve.classifications).toStrictEqual(['fixed']);
  });
});
