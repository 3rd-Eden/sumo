/**
 * Campsite-rule enforcement engine.
 *
 * Owns the full lifecycle for one hook invocation: payload parsing,
 * state-path resolution, finding detection, resolution lookup, and
 * stop-time gating.  The engine is agnostic to the host environment
 * (Cursor, Claude Code, CLI, tests) — it operates on structured inputs
 * and returns structured outputs.  Host-specific adapters handle
 * stdin/stdout and payload translation.
 *
 * All tunable values are driven by a frozen config object discovered
 * from the nearest ancestor `package.json` with a `"campsite"` key.
 * When no config is found, built-in defaults apply.
 *
 * @module engine
 */
import './guard.js';

import { rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, verification, migrate } from './findings.js';
import { ResolutionLedger } from './ledger.js';
import { resolve as resolveConfig } from './config.js';

/**
 * Core orchestration for campsite-rule enforcement.
 *
 * Each instance tracks findings for one session and evaluates stop-time
 * gating against a persistent resolution ledger.
 */
export class CampsiteEngine {
  /** @type {string|null} */
  #statePath;

  /** @type {ResolutionLedger} */
  #ledger;

  /** @type {object} */
  #config;

  /** @type {object[]|null} */
  #findings = null;

  /** @type {Set<string>} */
  #artifacts = new Set();

  /** @type {string|null} */
  #nonce = null;

  /**
   * @param {object} opts
   * @param {string|null} opts.statePath - Session state file path.
   * @param {string} [opts.repo] - Repository root for the resolution ledger.
   * @param {object} [opts.config] - Pre-resolved config.  When omitted,
   *   auto-discovered from the nearest ancestor `package.json`.
   */
  constructor({ statePath, repo, config }) {
    this.#config = config ?? resolveConfig(repo);
    this.#statePath = statePath;
    this.#ledger = new ResolutionLedger(repo, this.#config);
  }

  /**
   * Resolve the state file path from the hook payload.
   *
   * Derives a temp-directory path from the `session_id` field that
   * IDEs include in every hook payload.  Returns null when no
   * session context is available (e.g. direct CLI invocation).
   *
   * @param {object} input - Hook payload.
   * @param {object} [config] - State config slice with `directory`
   *   and `filePrefix`.
   * @returns {string|null} Absolute path to the state file.
   */
  static resolve(input, config) {
    if (input?.session_id) {
      const safe = String(input.session_id).replace(/[^a-zA-Z0-9_-]/g, '-');
      const prefix = config?.filePrefix ?? 'campsite-';
      const dir = config?.directory ?? tmpdir();

      return join(dir, `${prefix}${safe}.json`);
    }

    return null;
  }

  /**
   * Expose the frozen config for adapter access.
   *
   * @returns {object} Frozen config.
   */
  get config() {
    return this.#config;
  }

  /**
   * Initialize a clean session by removing stale state.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#statePath) {
      await rm(this.#statePath, { force: true });
    }
  }

  /**
   * Scan agent text for dismissive language and persist any findings.
   *
   * New findings are written to both the session state (for stop-time
   * gating) and the ledger (for durable context that survives session
   * cleanup).
   *
   * @param {string} text - Agent response or thinking text.
   * @param {string} source - Source label (`response` or `thought`).
   * @returns {Promise<object[]>} Newly detected findings.
   */
  async observe(text, source) {
    const hits = detect(text, source, this.#config.detection);

    if (hits.length === 0) return [];

    const findings = await this.#load();
    const added = this.#merge(findings, hits);
    await this.#save(findings);

    for (const finding of added) {
      await this.#ledger.record(finding.id, snapshot(finding, text, this.#config.snapshot));
    }

    return added;
  }

  /**
   * Record a verification failure.
   *
   * @param {object} input - Hook payload with tool metadata.
   * @param {string} command - Verification command string.
   * @param {string} failureType - Failure category.
   * @param {string} error - Human-readable failure detail.
   * @returns {Promise<object>} The recorded finding.
   */
  async fail(input, command, failureType, error) {
    const finding = verification(input, command, failureType, error);
    const findings = await this.#load();

    this.#merge(findings, [finding]);
    await this.#save(findings);
    await this.#ledger.record(finding.id, snapshot(finding));

    return finding;
  }

  /**
   * Clear matching verification failures after a green rerun.
   *
   * The hook still records failed verification commands, but a later passing
   * run for the same command is enough to close that runtime reminder. Other
   * finding kinds stay active because they need separate triage.
   *
   * @param {string} [command] - Passing verification command.
   * @returns {Promise<void>}
   */
  async pass(command) {
    const findings = await this.#load();
    const filtered = findings.filter(function keep(finding) {
      if (finding.kind !== 'verification') return true;
      if (!command) return false;
      return finding.command !== command;
    });

    if (filtered.length === findings.length) return;

    if (filtered.length === 0) {
      if (this.#statePath) {
        await rm(this.#statePath, { force: true });
      }

      this.#findings = null;
      return;
    }

    this.#findings = filtered;
    await this.#save(filtered);
  }

  /**
   * Compute findings that remain unresolved after subtracting proven
   * resolutions from the ledger.
   *
   * @returns {Promise<object[]>} Active unresolved findings.
   */
  async active() {
    const findings = await this.#load();
    const active = [];

    for (const finding of findings) {
      const proof = await this.#ledger.proven(finding.id);

      if (!proof) {
        active.push(finding);
      }
    }

    return active;
  }

  /**
   * Resolve a finding by updating its ledger entry with a cause of action.
   *
   * The finding context is normally recorded in the ledger at detection
   * time.  When the ledger entry is missing (orphan — session state saved
   * but ledger write failed), `#recover` rehydrates it from session state
   * before proceeding.  This method then merges the classification,
   * evidence, and session into the entry and evicts the finding from
   * the session state file so future `active()` calls never re-check it.
   *
   * Eviction is the second line of defense: the ledger proof is the
   * primary record, but removing the finding from session state ensures
   * it stays resolved even if external processes (tests, manual cleanup)
   * disturb the ledger.
   *
   * @param {string} id - Finding fingerprint.
   * @param {object} proof - Resolution evidence.
   * @param {string} proof.classification - Issue classification.
   * @param {string} proof.evidence - Evidence reference.
   * @param {string} [proof.model] - Optional self-reported model identity,
   *   unless `resolve.requireModel` is true.
   * @param {string} [proof.effort] - Optional self-reported reasoning effort,
   *   unless `resolve.requireEffort` is true.
   * @param {string} [proof.subject] - Fixed-proof subject for dismissive
   *   findings (`policy-docs`, `verification`, or `implementation`).
   * @param {string} [proof.relatedFindingId] - Linked finding that proves the
   *   underlying bug was handled.
   * @param {string} [proof.verificationCommand] - Verification command rerun to
   *   prove the fix.
   * @param {string} [proof.verificationEvidence] - Artifact showing the rerun
   *   command exited zero.
   * @param {string} [proof.testEvidence] - Regression test artifact for a
   *   behavior fix.
   * @param {string} [proof.session] - Session ID.
   * @returns {Promise<void>}
   */
  async resolve(id, proof) {
    if (!(await this.#ledger.lookup(id))) {
      if (!(await this.#recover(id))) {
        throw new Error(`finding not found: ${id}`);
      }
    }

    if (await this.#ledger.proven(id)) {
      throw new Error(`finding already resolved: ${id}`);
    }

    await this.#verifyNonce(proof?.nonce);
    this.#verifyArtifactProvenance(proof);

    const { nonce: _, ...ledgerProof } = proof ?? {};

    await this.#rejectBulkEvidence(id, ledgerProof.evidence ?? '');
    await this.#ledger.prove(id, ledgerProof);
    await this.#evict(id);
    await this.#rotateNonce();
  }

  /**
   * Verify the proof nonce matches the current session nonce.
   *
   * The nonce is generated at session-start and rotated after each
   * successful resolution.  A missing or mismatched nonce indicates
   * the resolve call did not come through the hook pipeline.
   *
   * @param {string|undefined} provided - Nonce from the proof.
   * @returns {Promise<void>}
   */
  async #verifyNonce(provided) {
    const expected = await this.nonce();

    if (!expected) return;

    if (provided !== expected) {
      throw new Error('invalid or missing session nonce');
    }
  }

  /**
   * Rotate the session nonce after a successful resolution.
   *
   * @returns {Promise<void>}
   */
  async #rotateNonce() {
    if (!this.#nonce) return;

    const { randomUUID } = await import('node:crypto');

    await this.setNonce(randomUUID());
  }

  /**
   * Verify that verification evidence points to a hook-registered
   * artifact rather than a fabricated file.
   *
   * Only enforced when the session has registered artifacts (meaning
   * the hook pipeline wrote proof files during this session).
   *
   * @param {object} proof - Resolution proof being validated.
   */
  #verifyArtifactProvenance(proof) {
    if (this.#artifacts.size === 0) return;

    const path = proof?.verificationEvidence;

    if (!path) return;

    if (!this.registered(path)) {
      throw new Error(
        `verificationEvidence was not produced by the hook pipeline: ${path}`
      );
    }
  }

  /**
   * Remove a resolved finding from the session state file.
   *
   * After a finding is proven in the ledger, keeping it in the session
   * state is redundant — and risky, because any ledger disruption would
   * cause the finding to reappear in stop prompts.  Eviction closes
   * that gap.
   *
   * @param {string} id - Finding fingerprint to remove.
   * @returns {Promise<void>}
   */
  async #evict(id) {
    if (!this.#statePath) return;

    const findings = await this.#load();
    const filtered = findings.filter(function keep(f) {
      return f.id !== id;
    });

    if (filtered.length === findings.length) return;

    if (filtered.length === 0) {
      await rm(this.#statePath, { force: true });
      this.#findings = null;
      return;
    }

    this.#findings = filtered;
    await this.#save(filtered);
  }

  /**
   * Recover an orphaned finding from session state into the ledger.
   *
   * A finding can end up in session state without a corresponding ledger
   * entry when the ledger write in `fail()` or `observe()` throws after
   * the session state was already saved.  Without recovery, `resolve()`
   * rejects the finding as "not found" and the stop hook loops forever.
   *
   * @param {string} id - Finding fingerprint to recover.
   * @returns {Promise<object|null>} The recovered ledger entry, or null
   *   when the finding does not exist in session state either.
   */
  async #recover(id) {
    const findings = await this.#load();
    const orphan = findings.find(function match(f) {
      return f.id === id;
    });

    if (!orphan) return null;

    const entry = snapshot(orphan);
    await this.#ledger.record(id, entry);
    return entry;
  }

  /**
   * Reject copy-pasted evidence once it exceeds the configured reuse limit.
   *
   * Resolve happens across separate hook invocations, so the ledger is the
   * durable source of truth for prior evidence reuse.
   *
   * @param {string} id - Finding fingerprint being resolved.
   * @param {string} evidence - Proposed evidence string.
   * @returns {Promise<void>}
   */
  async #rejectBulkEvidence(id, evidence) {
    const max = this.#config.resolve?.maxIdenticalEvidence;
    const normalized = String(evidence ?? '').trim();
    const limit = Number(max);

    if (!normalized) return;
    if (max == null || !Number.isFinite(limit) || limit <= 0) return;

    const entries = await this.#ledger.all();
    const duplicates = entries.filter(function reused(entry) {
      return entry.id !== id && entry.classification !== null && entry.evidence === normalized;
    });

    if (duplicates.length >= limit) {
      throw new Error(`identical evidence exceeded bulk threshold: ${normalized}`);
    }
  }

  /**
   * Increment prompt counters for unresolved findings shown at stop time.
   *
   * The stop prompt escalates only if the same unresolved finding appears in
   * consecutive completions, so the counter is persisted in session state.
   *
   * @param {object[]} unresolved - Active unresolved findings.
   * @returns {Promise<void>}
   */
  async #markPrompts(unresolved) {
    if (!this.#statePath) return;

    const ids = new Set(
      unresolved.map(function id(f) {
        return f.id;
      })
    );
    const findings = await this.#load();
    let changed = false;

    for (const finding of findings) {
      if (!ids.has(finding.id)) continue;

      finding.promptCount = (finding.promptCount ?? 0) + 1;
      changed = true;
    }

    if (changed) {
      await this.#save(findings);
    }
  }

  /**
   * Format the stop followup message from active findings.
   *
   * Returns `null` when all findings are resolved, signaling that
   * the session can complete cleanly.
   *
   * @returns {Promise<string|null>} Followup message, or null.
   */
  async format() {
    const unresolved = await this.active();

    if (unresolved.length === 0) return null;

    await this.#markPrompts(unresolved);

    const fmt = this.#config.format;
    const parts = [];

    const intro = (fmt.stopIntro ?? 'Campsite hook flagged {count} concrete issue{s} to resolve before completion.')
      .replace('{count}', String(unresolved.length))
      .replace('{s}', unresolved.length === 1 ? '' : 's');

    parts.push(intro);
    parts.push(problems(unresolved, fmt));
    parts.push(next(fmt, unresolved, this.#config.resolve));

    return parts.join('\n\n');
  }

  /**
   * Register a hook-produced proof artifact path so the resolver
   * can later verify the artifact was written by the hook pipeline
   * rather than fabricated by an agent.
   *
   * @param {string} path - Absolute path to the proof artifact.
   * @returns {Promise<void>}
   */
  async register(path) {
    const findings = await this.#load();

    this.#artifacts.add(path);
    await this.#save(findings);
  }

  /**
   * Check whether a proof artifact was registered by the hook.
   *
   * @param {string} path - Artifact path from a resolution proof.
   * @returns {boolean} True when the path was registered.
   */
  registered(path) {
    return this.#artifacts.has(path);
  }

  /**
   * Set the session nonce and persist it.
   *
   * Called at session-start to generate the initial nonce and after
   * each successful resolution to rotate it.
   *
   * @param {string} value - New nonce value.
   * @returns {Promise<void>}
   */
  async setNonce(value) {
    const findings = await this.#load();

    this.#nonce = value;
    await this.#save(findings);
  }

  /**
   * Read the current session nonce.
   *
   * @returns {Promise<string|null>} Current nonce, or null.
   */
  async nonce() {
    await this.#load();
    return this.#nonce;
  }

  /**
   * Expose the resolution ledger for direct access when needed.
   *
   * @returns {ResolutionLedger}
   */
  get ledger() {
    return this.#ledger;
  }

  // ── State persistence ───────────────────────────────────────────

  /**
   * Load findings from the session state file.
   *
   * Handles both the new `findings[]` format and the legacy format
   * with separate `hits[]`, `failures[]`, and `phrases[]` arrays.
   *
   * @returns {Promise<object[]>} Finding records.
   */
  async #load() {
    if (this.#findings) return this.#findings;

    if (!this.#statePath) {
      this.#findings = [];
      return this.#findings;
    }

    try {
      const text = await readFile(this.#statePath, 'utf8');
      const data = JSON.parse(text);

      this.#findings = data.findings ?? migrate(data);
      this.#artifacts = new Set(data.artifacts ?? []);
      this.#nonce = data.nonce ?? null;
    } catch {
      this.#findings = [];
    }

    return this.#findings;
  }

  /**
   * Persist the current findings, artifact registry, and nonce to the
   * session state file.
   *
   * When no state path is available, discards the in-memory cache so
   * findings do not accumulate in a non-persistent session.
   *
   * @param {object[]} findings - Finding records to persist.
   */
  async #save(findings) {
    if (!this.#statePath) {
      this.#findings = null;
      return;
    }

    this.#findings = findings;

    await writeFile(this.#statePath, JSON.stringify({
      findings,
      artifacts: [...this.#artifacts],
      nonce: this.#nonce
    }), 'utf8');
  }

  /**
   * Merge new findings into the list, deduplicating by finding ID.
   *
   * @param {object[]} existing - Current findings.
   * @param {object[]} incoming - New findings to add.
   * @returns {object[]} The subset of incoming findings that were new.
   */
  #merge(existing, incoming) {
    const seen = new Set(
      existing.map(function id(f) {
        return f.id;
      })
    );
    const added = [];

    for (const finding of incoming) {
      if (seen.has(finding.id)) continue;

      existing.push(finding);
      seen.add(finding.id);
      added.push(finding);
    }

    return added;
  }
}

/**
 * Build a training-grade context snapshot from a finding record.
 *
 * Captures enough context to understand the agent's reasoning chain
 * that led to the dismissal — not just the matched phrase but the
 * surrounding paragraph that shows *why* the agent said it.  Combined
 * with the resolution data added by `prove()`, each ledger entry
 * becomes a labeled training example: input (context + phrase),
 * signal (kind + source), label (classification + evidence).
 *
 * @param {object|undefined} finding - The finding from session state.
 * @param {string} [text] - Full agent response or thought text, used
 *   to extract the surrounding paragraph for richer context.
 * @param {object} [snapshotConfig] - Snapshot config slice with
 *   `contextRadius` and `paragraphDelimiter`.
 * @returns {object|null} Snapshot, or null when the finding was
 *   not found (e.g. resolved from a different session).
 */
function snapshot(finding, text, snapshotConfig) {
  if (!finding) return null;

  if (finding.kind === 'verification') {
    return {
      id: finding.id,
      kind: finding.kind,
      command: finding.command,
      cwd: finding.cwd || null,
      failureType: finding.failureType,
      error: finding.error
    };
  }

  return {
    id: finding.id,
    kind: finding.kind,
    source: finding.source,
    phrase: finding.phrase,
    snippet: finding.snippet,
    context: context(text, finding.offset, finding.phrase.length, snapshotConfig)
  };
}

/**
 * Extract a multi-paragraph window around a finding for training context.
 *
 * Grabs the paragraph containing the match plus the previous and next
 * paragraphs (delimited by blank lines).  When no boundary is found
 * within range, falls back to `contextRadius` characters each direction.
 *
 * Three paragraphs gives enough surrounding material for a reviewer or
 * training pipeline to understand the reasoning that led to the
 * dismissive phrase, not just the sentence containing it.
 *
 * @param {string} [text] - Full agent text.
 * @param {number} [offset] - Start of the matched phrase.
 * @param {number} [length] - Length of the matched phrase.
 * @param {object} [config] - Snapshot config slice.
 * @returns {string|null} Surrounding paragraphs, or null.
 */
function context(text, offset, length, config) {
  if (!text || offset == null) return null;

  const radius = config?.contextRadius ?? 500;
  const delimiter = config?.paragraphDelimiter ?? '\n\n';

  const innerBefore = text.lastIndexOf(delimiter, offset);
  const innerAfter = text.indexOf(delimiter, offset + (length ?? 0));

  const outerBefore = innerBefore > 0 ? text.lastIndexOf(delimiter, innerBefore - 1) : -1;
  const outerAfter = innerAfter !== -1 ? text.indexOf(delimiter, innerAfter + delimiter.length) : -1;

  const start =
    outerBefore !== -1 ? outerBefore + delimiter.length : innerBefore !== -1 ? 0 : Math.max(0, offset - radius);

  const end =
    outerAfter !== -1
      ? outerAfter
      : innerAfter !== -1
        ? text.length
        : Math.min(text.length, offset + (length ?? 0) + radius);

  return text.slice(start, end).trim();
}

// ── Formatting helpers ────────────────────────────────────────────

/**
 * Format all unresolved findings into one evidence-first section.
 *
 * @param {object[]} findings - Active unresolved findings.
 * @param {object} fmt - Format config slice.
 * @returns {string} Human-readable problem summary.
 */
function problems(findings, fmt) {
  const dismissive = findings.filter(function d(f) {
    return f.kind === 'dismissive';
  });
  const verifications = findings.filter(function v(f) {
    return f.kind === 'verification';
  });
  const parts = [];

  if (dismissive.length > 0) {
    parts.push(formatDismissive(dismissive, fmt));
  }

  if (verifications.length > 0) {
    parts.push(formatVerifications(verifications));
  }

  return parts.join('\n\n');
}

/**
 * Format dismissive findings for the followup message.
 *
 * @param {object[]} findings - Dismissive findings.
 * @param {object} fmt - Format config slice.
 * @returns {string} Formatted section.
 */
function formatDismissive(findings, fmt) {
  const labels = fmt?.sourceLabels ?? { thought: 'agent thought', response: 'agent response' };

  const lines = findings.map(function line(f) {
    const src = labels[f.source] ?? labels.response;
    return `- [${f.id}] ${src}: "${f.phrase}" in "${f.snippet}"`;
  });

  return `Dismissive language detected in this session:\n${lines.join('\n')}`;
}

/**
 * Format verification findings for the followup message.
 *
 * @param {object[]} findings - Verification findings.
 * @returns {string} Formatted section.
 */
function formatVerifications(findings) {
  const heading =
    findings.length === 1
      ? 'A verification command failed in this session:'
      : 'Verification commands failed in this session:';

  const lines = findings.map(function line(f) {
    const meta = [];

    if (f.cwd) meta.push(`cwd: ${f.cwd}`);
    if (f.toolUseId) meta.push(`tool: ${f.toolUseId}`);
    if (f.failureType && f.failureType !== 'non_zero_exit') meta.push(f.failureType);

    return `- [${f.id}] \`${f.command}\`${meta.length ? ` (${meta.join(', ')})` : ''}: ${f.error}`;
  });

  return `${heading}\n${lines.join('\n')}`;
}

/**
 * Format the concrete next steps the agent should take.
 *
 * @param {object} fmt - Format config slice.
 * @param {object[]} findings - Active unresolved findings.
 * @param {object} [resolveConfig] - Resolve config slice.
 * @returns {string} Numbered next-step guidance.
 */
function next(fmt, findings, resolveConfig) {
  const skillPath = fmt?.skillPath ?? '.agents/skills/campsite-rule/SKILL.md';
  const cli = fmt?.resolveCli ?? 'node .agents/skills/campsite-rule/bin/hook.js --repo . resolve';
  const escalation = escalate(findings, resolveConfig?.escalationThresholds ?? [2, 3]);
  const lines = [
    `Apply \`${skillPath}\` now — read it, classify each finding, route to the owning skill, and resolve before completion.`,
    ''
  ];

  if (escalation) {
    lines.push(escalation, '');
  }

  lines.push(
    'Next:',
    '1. Use only these resolution classifications: `fixed`, `triaged`, `false-positive`, `bypassed`.',
    '2. Fixing the discovered issue is the priority over continuing your original task.',
    '3. `fixed` means the underlying bug is handled now. `triaged` means you investigated, recorded the concrete state, and either bounded follow-up or user sequencing is the honest next step. `false-positive` means the phrase was quoted, fenced, or campsite-meta. `bypassed` is only for a real external outage where a code change would be harmful.',
    '4. If the defect is unclear or runtime-driven, do a bounded investigation before choosing how to resolve it.',
    '5. Passing verification reruns clear matching verification findings automatically. Dismissive findings stay active until you resolve them with the action or trace you produced.',
    '6. Do not mark the task complete until each issue is fixed, triaged, proven to be a false positive, or explicitly bypassed due to an external condition.',
    '7. If a file is already modified in the working tree, inspect `git diff` and describe the concrete change. Do not rely on who changed it or when it changed.',
    '8. Resolve handled findings after you have evidence. One root-cause artifact may support multiple related findings:',
    '   ```',
    `   echo '{"findingId":"<id>","classification":"fixed|triaged|false-positive|bypassed","evidence":"<artifact path, sha, issue, or trace>","subject":"policy-docs|verification|implementation","relatedFindingId":"<finding id when useful>","verificationCommand":"<rerun command when useful>","verificationEvidence":"<passing rerun artifact>","testEvidence":"<regression test artifact when useful>"}' | ${cli}`,
    '   ```',
    '   The evidence field should point at the artifact, command trace, issue, or external condition. Include extra proof fields only when they add useful context.'
  );

  return lines.join('\n');
}

/**
 * Compute the escalation banner for repeated unresolved stop prompts.
 *
 * @param {object[]} findings - Active unresolved findings.
 * @param {number[]} thresholds - Escalation thresholds.
 * @returns {string|null} Escalation banner, or null.
 */
function escalate(findings, thresholds) {
  const seen = Math.max(
    ...findings.map(function count(f) {
      return f.promptCount ?? 1;
    })
  );
  const [warn = 2, stop = 3] = thresholds;
  const singular = findings.length === 1;

  if (seen >= stop) {
    return singular
      ? `This finding has been flagged ${seen} times. Stop current work and address this finding before proceeding.`
      : `At least one unresolved finding has been flagged ${seen} times. Stop current work and address these findings before proceeding.`;
  }

  if (seen >= warn) {
    return singular
      ? 'This finding was previously flagged and remains unresolved.'
      : 'At least one unresolved finding was previously flagged and remains unresolved.';
  }

  return null;
}
