/**
 * Finding lifecycle ledger for the campsite engine.
 *
 * Tracks every finding from discovery through resolution in a single
 * persistent store outside the repository.  Entries are created at
 * detection time with the finding's context snapshot, then enriched
 * at resolution time with classification, evidence, model, effort, and session.
 *
 * Storage location and filename are configurable through the `ledger`
 * config slice.  Defaults to `$HOME/.local/share/campsite/` with a
 * subdirectory derived from the repository root path, so each repo
 * gets isolated storage.
 *
 * @module ledger
 */
import './guard.js';

// cspell:ignore oneline
import { readFile, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { basename, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PLACEHOLDER_MODELS = new Set(['ai', 'llm', 'model']);

/**
 * Durable finding lifecycle storage.
 *
 * Each instance is bound to a specific repository root.  Entries are
 * stored in a JSON file under the configured base directory.
 */
export class ResolutionLedger {
  /** @type {string} */
  #path;

  /** @type {string} */
  #keyPath;

  /** @type {string} */
  #repo;

  /** @type {Map<string, object>|null} */
  #cache = null;

  /** @type {Buffer|null} */
  #signingKey = null;

  /** @type {object} */
  #resolve;

  /**
   * @param {string} [repo] - Absolute path to the repository root.
   *   Defaults to `process.cwd()`.
   * @param {object} [config] - Full resolved config or a ledger-only slice.
   * @param {object} [config.ledger] - Ledger config slice when the full config
   *   object is passed.
   * @param {string} [config.ledger.baseDir] - Base directory for ledger storage.
   *   Supports `~` expansion. Defaults to `~/.local/share/campsite`.
   * @param {string} [config.ledger.fileName] - Ledger filename.
   *   Defaults to `ledger.json`.
   * @param {object} [config.resolve] - Resolve validation config slice.
   */
  constructor(repo, config) {
    const root = repo ?? process.cwd();
    const ledgerConfig = config?.ledger ?? config ?? {};
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const baseDir = ledgerConfig.baseDir ?? join(homedir(), '.local', 'share', 'campsite');
    const fileName = ledgerConfig.fileName ?? 'ledger.json';
    if (basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
      throw new Error('ledger.fileName must be a file name, not a path');
    }
    const dir = join(baseDir, hash);

    this.#repo = root;
    this.#path = join(dir, fileName);
    this.#keyPath = join(dir, '.key');
    this.#resolve = config?.resolve ?? {};
  }

  /**
   * Absolute path to the ledger file on disk.
   *
   * @type {string}
   */
  get path() {
    return this.#path;
  }

  /**
   * Record a newly discovered finding with its context snapshot.
   *
   * Creates a ledger entry at detection time so the finding's context
   * is always available — even when the session state file is gone by
   * the time the agent resolves the finding.
   *
   * Skips writing if the finding already has a ledger entry (duplicate
   * detection across sessions or re-observed phrases).
   *
   * @param {string} id - The finding's stable fingerprint.
   * @param {object} finding - Context snapshot (kind, source,
   *   phrase/command, snippet/error).
   */
  async record(id, finding) {
    const entries = await this.#load();

    if (entries.has(id)) return;

    entries.set(id, {
      id,
      finding,
      discovered: Date.now(),
      classification: null,
      evidence: null,
      session: null,
      resolved: null
    });

    await this.#save(entries);
  }

  /**
   * Resolve a finding by merging proof data into its ledger entry.
   *
   * Preserves the `finding` snapshot and `discovered` timestamp from
   * the original `record` call, enriching the entry with resolution
   * metadata.
   *
   * @param {string} id - The finding's stable fingerprint.
   * @param {object} proof - Resolution evidence.
   * @param {string} proof.classification - Resolution action label.
   * @param {string} proof.evidence - Artifact or bounded bypass reference.
   * @param {string} proof.model - Self-reported model identity.
   * @param {string} proof.effort - Self-reported reasoning effort.
   * @param {string} [proof.subject] - Fixed-proof subject (`policy-docs`,
   *   `verification`, or `implementation`) for dismissive findings.
   * @param {string} [proof.relatedFindingId] - Linked finding that proves the
   *   underlying bug was fixed.
   * @param {string} [proof.verificationCommand] - Verification command rerun to
   *   prove a fix.
   * @param {string} [proof.verificationEvidence] - Artifact showing the rerun
   *   command exited zero.
   * @param {string} [proof.testEvidence] - Regression test artifact for a
   *   behavior fix.
   * @param {string} [proof.session] - Session ID where resolution happened.
   */
  async prove(id, proof) {
    const entries = await this.#load();
    const existing = entries.get(id) ?? { id };
    const valid = await this.validate(proof, existing.finding, entries);

    const entry = {
      ...existing,
      classification: valid.classification,
      evidence: valid.evidence,
      model: valid.model,
      effort: valid.effort,
      subject: valid.subject ?? existing.subject ?? null,
      relatedFindingId: valid.relatedFindingId ?? existing.relatedFindingId ?? null,
      verificationCommand: valid.verificationCommand ?? existing.verificationCommand ?? null,
      verificationEvidence: valid.verificationEvidence ?? existing.verificationEvidence ?? null,
      testEvidence: valid.testEvidence ?? existing.testEvidence ?? null,
      session: valid.session ?? existing.session ?? null,
      resolved: Date.now()
    };

    entry.integrity = await this.#sign(entry);
    entries.set(id, entry);
    await this.#save(entries);
  }

  /**
   * Validate a resolution proof before it is persisted.
   *
   * The validation gate rejects malformed, weak, or abusive proofs before
   * they can suppress a finding in the stop prompt.
   *
   * @param {object} proof - Proposed resolution proof.
   * @param {object|null|undefined} finding - Recorded finding snapshot.
   * @param {Map<string, object>} [entries] - Current ledger entries for linked
   *   finding validation.
   * @returns {Promise<object>} Normalized proof.
   */
  async validate(proof, finding, entries) {
    const resolve = this.#resolve;
    const requireModel = resolve.requireModel ?? false;
    const requireEffort = resolve.requireEffort ?? false;
    const fixedOnly = ['subject', 'relatedFindingId', 'verificationCommand', 'verificationEvidence', 'testEvidence'];
    const required = ['classification', 'evidence'];

    if (requireModel) {
      required.push('model');
    }

    if (requireEffort) {
      required.push('effort');
    }

    const allowed = new Set([...required, 'model', 'effort', 'session', ...fixedOnly]);
    const missing = [];

    for (const field of required) {
      if (!(field in (proof ?? {}))) {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      throw new Error(`missing proof field(s): ${missing.join(', ')}`);
    }

    for (const field of required) {
      if (typeof proof[field] !== 'string') {
        throw new Error(`invalid proof field "${field}": expected string`);
      }
    }

    for (const field of fixedOnly) {
      if (field in (proof ?? {}) && proof[field] != null && typeof proof[field] !== 'string') {
        throw new Error(`invalid proof field "${field}": expected string`);
      }
    }

    for (const field of ['model', 'effort']) {
      if (field in (proof ?? {}) && proof[field] != null && typeof proof[field] !== 'string') {
        throw new Error(`invalid proof field "${field}": expected string`);
      }
    }

    if ('session' in (proof ?? {}) && proof.session != null && typeof proof.session !== 'string') {
      throw new Error('invalid proof field "session": expected string');
    }

    const extra = Object.keys(proof ?? {}).filter(function unknown(key) {
      return !allowed.has(key);
    });

    if (extra.length > 0) {
      throw new Error(`unknown proof field(s): ${extra.join(', ')}`);
    }

    const model = typeof proof.model === 'string' ? proof.model.trim() : '';
    const effort = typeof proof.effort === 'string' ? proof.effort.trim() : '';
    const classification = proof.classification.trim();
    const evidence = proof.evidence.trim();
    const subject = typeof proof.subject === 'string' ? proof.subject.trim() : '';
    const relatedFindingId = typeof proof.relatedFindingId === 'string' ? proof.relatedFindingId.trim() : '';
    const verificationCommand = typeof proof.verificationCommand === 'string' ? proof.verificationCommand.trim() : '';
    const verificationEvidence =
      typeof proof.verificationEvidence === 'string' ? proof.verificationEvidence.trim() : '';
    const testEvidence = typeof proof.testEvidence === 'string' ? proof.testEvidence.trim() : '';
    const session = typeof proof.session === 'string' ? proof.session.trim() : (proof.session ?? null);
    const classifications = resolve.classifications ?? ['fixed', 'triaged', 'false-positive', 'bypassed'];
    const minEvidenceLength = resolve.minEvidenceLength ?? 12;
    const minModelLength = resolve.minModelLength ?? 3;

    if (!classifications.includes(classification)) {
      throw new Error(`invalid classification: ${classification}`);
    }

    if (requireModel && (model.length < minModelLength || PLACEHOLDER_MODELS.has(model.toLowerCase()))) {
      throw new Error(`invalid model identity: ${model}`);
    }

    if (requireEffort && effort.length === 0) {
      throw new Error('missing reasoning effort');
    }

    if (evidence.length < minEvidenceLength) {
      throw new Error(`evidence is too short: ${evidence}`);
    }

    if (!matches(evidence, resolve.evidencePatterns?.generic)) {
      throw new Error(`evidence must reference a verifiable artifact: ${evidence}`);
    }

    if (classification === 'fixed' && !matches(evidence, resolve.evidencePatterns?.fixed)) {
      throw new Error(`fixed evidence must reference a commit SHA, file path, or URL: ${evidence}`);
    }

    if (classification === 'false-positive' && !matches(evidence, resolve.evidencePatterns?.falsePositive)) {
      throw new Error(`false-positive evidence must name the quoted, fenced, or meta filter: ${evidence}`);
    }

    if (classification === 'bypassed' && !matches(evidence, resolve.evidencePatterns?.bypassed)) {
      throw new Error(`bypassed evidence must describe the outage or external condition: ${evidence}`);
    }

    if ((resolve.verifyArtifacts ?? true) && classification === 'fixed') {
      await this.#verifyArtifact(evidence);
    }

    const fixed =
      classification === 'fixed'
        ? await this.#validateFixed({
            evidence,
            finding,
            subject,
            relatedFindingId,
            verificationCommand,
            verificationEvidence,
            testEvidence,
            entries
          })
        : {};

    return {
      classification,
      evidence,
      model: model || null,
      effort: effort || null,
      subject: fixed.subject ?? null,
      relatedFindingId: fixed.relatedFindingId ?? null,
      verificationCommand: fixed.verificationCommand ?? null,
      verificationEvidence: fixed.verificationEvidence ?? null,
      testEvidence: fixed.testEvidence ?? null,
      session
    };
  }

  /**
   * Check whether a finding has been resolved.
   *
   * A finding is considered resolved when its `classification` is set
   * (i.e. `prove` has been called for it).
   *
   * @param {string} id - The finding's stable fingerprint.
   * @returns {Promise<object|null>} The entry if resolved, or null.
   */
  async proven(id) {
    const entries = await this.#load();
    const entry = entries.get(id);

    if (!entry || entry.classification === null) return null;
    if (!(await this.#verify(entry))) return null;
    return entry;
  }

  /**
   * Look up a finding's context snapshot from the ledger.
   *
   * @param {string} id - The finding's stable fingerprint.
   * @returns {Promise<object|null>} The full entry, or null.
   */
  async lookup(id) {
    const entries = await this.#load();
    return entries.get(id) ?? null;
  }

  /**
   * Return all ledger entries.
   *
   * @returns {Promise<object[]>} Array of entries.
   */
  async all() {
    const entries = await this.#load();
    return Array.from(entries.values());
  }

  /**
   * Load the ledger from disk into the in-memory cache.
   *
   * @returns {Promise<Map<string, object>>} Cached entries.
   */
  async #load() {
    if (this.#cache) return this.#cache;

    try {
      const text = await readFile(this.#path, 'utf8');
      const data = JSON.parse(text);
      this.#cache = new Map(Object.entries(data));
    } catch {
      this.#cache = new Map();
    }

    return this.#cache;
  }

  /**
   * Persist the in-memory cache to disk.
   *
   * @param {Map<string, object>} entries - Current ledger entries.
   */
  async #save(entries) {
    const dir = this.#path.slice(0, this.#path.lastIndexOf('/'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(this.#path, JSON.stringify(Object.fromEntries(entries), null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.#path, 0o600);
    this.#cache = entries;
  }

  /**
   * Load or generate the repo-specific HMAC signing key.
   *
   * The key is created on first use and stored alongside the ledger
   * so it persists across sessions.  An agent would need to find
   * this file and know the signing algorithm to forge an entry.
   *
   * @returns {Promise<Buffer>} 32-byte signing key.
   */
  async #key() {
    if (this.#signingKey) return this.#signingKey;

    try {
      this.#signingKey = await readFile(this.#keyPath);
      return this.#signingKey;
    } catch {
      const { randomBytes } = await import('node:crypto');
      const key = randomBytes(32);
      const dir = this.#keyPath.slice(0, this.#keyPath.lastIndexOf('/'));

      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeFile(this.#keyPath, key, { mode: 0o600 });
      await chmod(this.#keyPath, 0o600);
      this.#signingKey = key;
      return key;
    }
  }

  /**
   * Compute an HMAC signature for a ledger entry's critical fields.
   *
   * @param {object} entry - Ledger entry to sign.
   * @returns {Promise<string>} Hex-encoded HMAC.
   */
  async #sign(entry) {
    const key = await this.#key();
    const { createHmac } = await import('node:crypto');
    const payload = [entry.id, entry.classification, entry.evidence, String(entry.resolved)].join('\0');

    return createHmac('sha256', key).update(payload).digest('hex');
  }

  /**
   * Verify a ledger entry's HMAC integrity.
   *
   * Entries without an `integrity` field (pre-HMAC entries) fail
   * verification, causing them to be treated as unproven.
   *
   * @param {object} entry - Ledger entry to verify.
   * @returns {Promise<boolean>} True when the HMAC is valid.
   */
  async #verify(entry) {
    if (!entry.integrity) return false;

    const expected = await this.#sign(entry);
    const { timingSafeEqual } = await import('node:crypto');

    try {
      return timingSafeEqual(Buffer.from(entry.integrity, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Verify a fixed-evidence artifact against the local repo.
   *
   * Commit SHAs are checked against git history. File paths are checked on
   * disk. URLs are allowed but cannot be verified locally, so they pass
   * without additional checks.
   *
   * @param {string} evidence - Evidence string from the resolution proof.
   * @returns {Promise<void>}
   */
  async #verifyArtifact(evidence) {
    const sha = evidence.match(/\b[a-f0-9]{7,40}\b/i)?.[0] ?? null;

    if (sha) {
      try {
        await run('git', ['log', '--oneline', sha], { cwd: this.#repo });
        return;
      } catch {
        throw new Error(`commit SHA not found in git history: ${sha}`);
      }
    }

    const path = filePath(evidence, this.#repo);

    if (path) {
      try {
        await stat(path);
        return;
      } catch {
        throw new Error(`referenced file not found: ${path}`);
      }
    }

    if (/https?:\/\/\S+/i.test(evidence)) {
      return;
    }

    throw new Error(`fixed evidence is not locally verifiable: ${evidence}`);
  }

  /**
   * Ensure policy-docs proofs point at policy or documentation surfaces.
   *
   * File-path evidence may also self-identify an inline comment change. Commit
   * SHAs must touch at least one policy/documentation file in repo history.
   *
   * @param {string} evidence - Evidence string from the resolution proof.
   * @returns {Promise<void>}
   */
  async #verifyPolicyEvidence(evidence) {
    const path = filePath(evidence, this.#repo);

    if (path) {
      if (isPolicyDocSurface(path) || /\bcomment\b/i.test(evidence)) {
        return;
      }

      throw new Error(
        `policy-docs evidence must point to a skill, README, rule, comment, or documentation file: ${evidence}`
      );
    }

    const sha = evidence.match(/\b[a-f0-9]{7,40}\b/i)?.[0] ?? null;

    if (sha) {
      const files = await this.#commitFiles(sha);

      if (files.some(isPolicyDocSurface)) {
        return;
      }

      throw new Error(
        `policy-docs evidence commit must touch a skill, README, rule, or documentation file: ${evidence}`
      );
    }

    if (/https?:\/\/\S+/i.test(evidence) && isPolicyDocSurface(evidence)) {
      return;
    }

    throw new Error(`policy-docs evidence must reference a policy/documentation surface: ${evidence}`);
  }

  /**
   * Ensure implementation proofs point at a regression test surface.
   *
   * Paths and URLs must look like test files. Commit SHAs must touch a test
   * file so implementation fixes cannot close dismissive findings with
   * arbitrary non-test artifacts.
   *
   * @param {string} evidence - Test evidence string from the resolution proof.
   * @returns {Promise<void>}
   */
  async #verifyTestEvidence(evidence) {
    const path = filePath(evidence, this.#repo);

    if (path) {
      if (isTestSurface(path)) {
        return;
      }

      throw new Error(`testEvidence must point to a regression test file: ${evidence}`);
    }

    const sha = evidence.match(/\b[a-f0-9]{7,40}\b/i)?.[0] ?? null;

    if (sha) {
      const files = await this.#commitFiles(sha);

      if (files.some(isTestSurface)) {
        return;
      }

      throw new Error(`testEvidence commit must touch a regression test file: ${evidence}`);
    }

    if (/https?:\/\/\S+/i.test(evidence) && isTestSurface(evidence)) {
      return;
    }

    throw new Error(`testEvidence must reference a regression test surface: ${evidence}`);
  }

  /**
   * List the files touched by a commit for subject-specific proof validation.
   *
   * @param {string} sha - Commit SHA already verified against local history.
   * @returns {Promise<string[]>} Changed file paths from git history.
   */
  async #commitFiles(sha) {
    const { stdout } = await run('git', ['show', '--pretty=', '--name-only', sha], { cwd: this.#repo });

    return stdout
      .split('\n')
      .map(function trim(line) {
        return line.trim();
      })
      .filter(Boolean);
  }

  /**
   * Enforce subject-specific proof rules for `fixed` resolutions.
   *
   * Fixed proof details are optional, but validated when present. This keeps
   * the hook from forcing a bespoke proof shape for every finding while still
   * catching mismatched verification transcripts and invalid linked subjects.
   *
   * @param {object} options
   * @param {object|null|undefined} options.finding - Recorded finding snapshot.
   * @param {string} options.subject - Declared subject for dismissive fixes.
   * @param {string} options.relatedFindingId - Linked finding ID.
   * @param {string} options.verificationCommand - Rerun verification command.
   * @param {string} options.verificationEvidence - Passing verification artifact.
   * @param {string} options.testEvidence - Regression test artifact.
   * @param {Map<string, object>} [options.entries] - Current ledger entries.
   * @returns {Promise<object>} Normalized fixed-only proof fields.
   */
  async #validateFixed(options) {
    const finding = options.finding ?? null;
    const details = {
      subject: options.subject || null,
      relatedFindingId: options.relatedFindingId || null,
      verificationCommand: options.verificationCommand || null,
      verificationEvidence: options.verificationEvidence || null,
      testEvidence: options.testEvidence || null
    };

    if (!finding) {
      return details;
    }

    if (options.verificationCommand || options.verificationEvidence) {
      if (!options.verificationCommand) {
        throw new Error('verification evidence must include verificationCommand');
      }

      if (!options.verificationEvidence) {
        throw new Error('verificationCommand must include verificationEvidence');
      }

      if (finding.kind === 'verification' && options.verificationCommand !== finding.command) {
        throw new Error(`verificationCommand must match finding command: ${finding.command}`);
      }

      await this.#verifyVerificationEvidence(options.verificationCommand, options.verificationEvidence);
    }

    const subjects = this.#resolve.subjects ?? ['policy-docs', 'verification', 'implementation'];

    if (options.subject && !subjects.includes(options.subject)) {
      throw new Error(`invalid subject: ${options.subject}`);
    }

    if (finding.kind !== 'dismissive') return details;

    if (options.subject === 'policy-docs') {
      await this.#verifyPolicyEvidence(options.evidence);
      return details;
    }

    if (options.subject === 'verification' && options.relatedFindingId) {
      if (options.relatedFindingId === finding.id) {
        throw new Error('relatedFindingId must reference a different finding');
      }

      const related = options.entries?.get(options.relatedFindingId) ?? null;

      if (!related) {
        throw new Error(`related finding not found: ${options.relatedFindingId}`);
      }

      if (related.finding?.kind !== 'verification') {
        throw new Error('relatedFindingId must reference a verification finding');
      }

      const classifications = this.#resolve.classifications ?? ['fixed', 'triaged', 'false-positive', 'bypassed'];

      if (!related.classification || !classifications.includes(related.classification)) {
        throw new Error('relatedFindingId must reference a resolved verification finding');
      }
    }

    if (options.subject === 'implementation' && options.testEvidence) {
      await this.#verifyArtifact(options.testEvidence);
      await this.#verifyTestEvidence(options.testEvidence);
    }

    return details;
  }

  /**
   * Verify that a proof artifact shows the same verification command exiting 0.
   *
   * Accepts either JSON hook payloads or plain-text terminal transcripts. This
   * keeps the proof contract usable both from tests and from real IDE sessions.
   *
   * @param {string} command - Verification command being proven.
   * @param {string} evidence - File path to the passing rerun artifact.
   * @returns {Promise<void>}
   */
  async #verifyVerificationEvidence(command, evidence) {
    const path = filePath(evidence, this.#repo);

    if (!path) {
      throw new Error(`verificationEvidence must reference a local file: ${evidence}`);
    }

    let text;

    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new Error(`verificationEvidence file not found: ${path}`);
    }

    const proof = verificationResult(text);

    if (!proof.command) {
      throw new Error(`verificationEvidence must include a command: ${evidence}`);
    }

    if (proof.command !== command) {
      throw new Error(`verificationEvidence must rerun the same command: expected ${command}, saw ${proof.command}`);
    }

    if (proof.exitCode !== 0) {
      throw new Error(`verificationEvidence must show exit code 0: ${evidence}`);
    }
  }
}

/**
 * Check whether a string matches any configured regex pattern.
 *
 * @param {string} text - Candidate text.
 * @param {string[]|undefined} patterns - Regex source strings.
 * @returns {boolean} True when any pattern matches.
 */
function matches(text, patterns) {
  return (patterns ?? []).some(function pattern(source) {
    return new RegExp(source, 'i').test(text);
  });
}

/**
 * Extract a file path-like token from evidence and resolve it to disk.
 *
 * @param {string} evidence - Evidence string from a resolution proof.
 * @param {string} repo - Repository root for relative-path resolution.
 * @returns {string|null} Absolute file path, or null.
 */
function filePath(evidence, repo) {
  // Rooted paths allow spaces in segments; bare paths don't to avoid false matches.
  const rooted = evidence.match(/(?:^|\s)((?:\/|\.{1,2}\/)(?:[^/\n]+\/)*[^/\n]+\.[A-Za-z0-9]+)/);
  const bare = rooted ? null : evidence.match(/(?:^|\s)((?:[^\s/]+\/)*[^\s/]+\.[A-Za-z0-9]+)/);
  const match = rooted ?? bare;

  if (!match?.[1]) return null;

  const path = match[1];

  if (isAbsolute(path)) {
    return path;
  }

  return pathResolve(repo, path);
}

/**
 * Decide whether an evidence target looks like policy or documentation work.
 *
 * Plan files do not count as closure for `policy-docs`, even if they are
 * markdown. Everything else stays intentionally lightweight so the ledger can
 * validate real repo artifacts without parsing file contents.
 *
 * @param {string} target - File path or URL-like string.
 * @returns {boolean} True when the target looks like policy/doc evidence.
 */
function isPolicyDocSurface(target) {
  const value = target.replace(/\\/g, '/');
  const base = value.split('/').pop() ?? value;

  if (/(^|\/)plans?(\/|$)/i.test(value) || /\bplan\b/i.test(base)) {
    return false;
  }

  return (
    /\.mdc(?:[?#].*)?$/i.test(value) ||
    /(^|\/)(README|AGENTS|CLAUDE|GEMINI)\.md(?:[?#].*)?$/i.test(value) ||
    /(^|\/)SKILL\.md(?:[?#].*)?$/i.test(value) ||
    /\.md(?:[?#].*)?$/i.test(value)
  );
}

/**
 * Decide whether an evidence target looks like a regression test surface.
 *
 * @param {string} target - File path or URL-like string.
 * @returns {boolean} True when the target looks like test evidence.
 */
function isTestSurface(target) {
  const value = target.replace(/\\/g, '/');
  return /(^|\/)__tests__(\/|$)/i.test(value) || /\.(test|spec|bench|eval)\.[A-Za-z0-9]+(?:[?#].*)?$/i.test(value);
}

/**
 * Parse a passing verification artifact into command and exit-code fields.
 *
 * Supports both JSON payloads from the shell hook and plain-text terminal
 * transcripts captured by the IDE.
 *
 * @param {string} text - Artifact contents.
 * @returns {{ command: string|null, exitCode: number|null }} Parsed proof.
 */
function verificationResult(text) {
  try {
    const data = JSON.parse(text);
    return {
      command: commandValue(data),
      exitCode: exitCodeValue(data)
    };
  } catch {
    return {
      command: unquote(
        text.match(/^last_command:\s*(.+)$/m)?.[1]?.trim() ?? text.match(/^command:\s*(.+)$/m)?.[1]?.trim() ?? null
      ),
      exitCode: textExitCode(text)
    };
  }
}

/**
 * Strip surrounding double-quotes and unescape internal escaped quotes.
 *
 * Terminal metadata files store values like `command: "cd \"foo\" && bar"`.
 * The regex capture includes the outer quotes, and the value may contain
 * backslash-escaped double-quotes (`\"`). Downstream comparison expects the
 * bare command string with real double-quotes.
 *
 * @param {string|null} value - Raw captured header value.
 * @returns {string|null} Unquoted string, or null.
 */
function unquote(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/^"(.*)"$/, '$1');
  return stripped.replace(/\\"/g, '"');
}

/**
 * Extract the verification command from a JSON artifact payload.
 *
 * @param {object} data - Parsed JSON artifact.
 * @returns {string|null} Command string, or null.
 */
function commandValue(data) {
  const command =
    data?.tool_input?.command ??
    data?.toolInput?.command ??
    data?.last_command ??
    data?.lastCommand ??
    data?.command ??
    null;

  return typeof command === 'string' ? command.trim() : null;
}

/**
 * Extract the exit code from a JSON artifact payload.
 *
 * @param {object} data - Parsed JSON artifact.
 * @returns {number|null} Exit code, or null.
 */
function exitCodeValue(data) {
  const direct = numberValue(data?.exitCode ?? data?.exit_code ?? data?.last_exit_code ?? data?.lastExitCode);

  if (direct != null) {
    return direct;
  }

  if (data?.tool_output != null) {
    if (typeof data.tool_output === 'string') {
      try {
        return exitCodeValue(JSON.parse(data.tool_output));
      } catch {
        return textExitCode(data.tool_output);
      }
    }

    if (typeof data.tool_output === 'object') {
      return exitCodeValue(data.tool_output);
    }
  }

  return null;
}

/**
 * Parse an exit code from plain-text terminal output.
 *
 * @param {string} text - Plain-text artifact contents.
 * @returns {number|null} Exit code, or null.
 */
function textExitCode(text) {
  const match = text.match(/^exit_code:\s*(-?\d+)\s*$/m) ?? text.match(/^last_exit_code:\s*(-?\d+)\s*$/m);
  return numberValue(match?.[1] ?? null);
}

/**
 * Normalize a maybe-numeric value into an integer.
 *
 * @param {unknown} value - Candidate numeric value.
 * @returns {number|null} Parsed integer, or null.
 */
function numberValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return null;
}
