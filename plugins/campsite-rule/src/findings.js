/**
 * Finding detection, filtering, and identity for the campsite engine.
 *
 * This module owns the two-stage detection pipeline: candidate phrase
 * matching followed by analytical-context filtering that rejects quoted,
 * code-fenced, or meta-discussion text before it enters the finding
 * pipeline.  It also generates stable finding IDs so each finding can
 * be individually resolved without suppressing future occurrences of the
 * same phrase.
 *
 * All tunable values (phrase vocabulary, meta tokens, radii, thresholds)
 * live in `config.js` — that module is the single source of truth.
 * Functions here read from the `detection` config slice passed in by the
 * engine, falling back to `config.defaults().detection` when no config
 * is provided (convenience for direct callers and tests).
 *
 * @module findings
 */
import { createHash } from 'node:crypto';
import { defaults } from './config.js';

/**
 * Cached default detection config.
 *
 * Avoids re-creating the defaults object on every call when callers
 * omit the config argument.
 *
 * @type {object}
 */
const DEFAULTS = defaults().detection;

/**
 * Run the two-stage detection pipeline on a text block.
 *
 * Stage 1 collects every candidate phrase match with token-boundary
 * awareness and overlap collapsing.  Stage 2 rejects candidates that
 * appear inside quoted, code-fenced, or meta-discussion context.
 *
 * Each surviving finding gets a stable `id` so it can be individually
 * resolved later without suppressing future occurrences of the same
 * phrase in different contexts.
 *
 * @param {string} text - Agent response or thinking text.
 * @param {string} source - Where the text came from (`response` or `thought`).
 * @param {object} config - Detection config slice with `phrases`,
 *   `metaTokens`, `metaTokenThreshold`, `snippetRadius`,
 *   `metaParagraphFallback`, `backtickScanRadius`, `quoteLookaround`.
 * @returns {object[]} Structured finding records with stable IDs.
 */
export function detect(text, source, config) {
  const raw = candidates(text, source, config);
  const filtered = raw.filter(function keep(hit) {
    return !analytical(text, hit.offset, hit.length, config);
  });

  return filtered.map(function finding(hit) {
    const { length, ...rest } = hit;
    return { ...rest, id: fingerprint(rest) };
  });
}

/**
 * Collect all candidate phrase matches before filtering.
 *
 * Exported for testing the first stage independently.
 *
 * @param {string} text - Agent text to scan.
 * @param {string} source - Source label.
 * @param {object} config - Detection config slice.
 * @returns {object[]} Raw candidate hits with `length` preserved for filtering.
 */
export function candidates(text, source, config) {
  const phrases = config?.phrases ?? DEFAULTS.phrases;
  const radius = config?.snippetRadius ?? DEFAULTS.snippetRadius;
  const raw = [];

  for (const phrase of phrases) {
    raw.push(...collect(text, phrase, source, radius));
  }

  return collapse(raw);
}

/**
 * Generate a stable finding ID from a finding record.
 *
 * The fingerprint is a truncated SHA-256 of the finding's semantic
 * identity — kind, source, phrase, and a normalized digest of the
 * surrounding sentence.  The offset is deliberately excluded so that
 * identical content at different positions produces the same ID.
 *
 * Verification findings hash on command, cwd, failure type, and error
 * instead of phrase and snippet.
 *
 * @param {object} finding - Structured finding record.
 * @returns {string} 16-character hex fingerprint.
 */
export function fingerprint(finding) {
  const parts =
    finding.kind === 'verification'
      ? [finding.kind, finding.command, finding.cwd, finding.failureType, finding.error]
      : [finding.kind ?? 'dismissive', finding.source, finding.phrase, sentence(finding.snippet)];

  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/**
 * Build a verification finding record from tool event data.
 *
 * @param {object} input - Cursor hook payload for a Shell event.
 * @param {string} command - Verification command string.
 * @param {string} failureType - Failure category.
 * @param {string} error - Human-readable failure detail.
 * @returns {object} Structured verification finding with stable ID.
 */
export function verification(input, command, failureType, error) {
  const finding = {
    kind: 'verification',
    source: 'tool',
    command,
    cwd: input.cwd ?? '',
    toolUseId: input.tool_use_id ?? '',
    failureType,
    error,
    timestamp: Date.now()
  };

  finding.id = fingerprint(finding);
  return finding;
}

/**
 * Convert legacy state (pre-engine format) into finding records.
 *
 * Old state has `hits[]` and `failures[]` arrays without finding IDs.
 * Each converted finding is marked `legacy: true` so the engine can
 * distinguish them from structured findings for resolution policy.
 *
 * @param {object} state - Legacy persisted state.
 * @returns {object[]} Finding records with `legacy: true`.
 */
export function migrate(state) {
  if (!state) return [];

  const findings = [];

  if (state.hits) {
    for (const hit of state.hits) {
      const finding = {
        kind: 'dismissive',
        source: hit.source ?? 'response',
        phrase: hit.phrase,
        offset: hit.offset ?? 0,
        snippet: hit.snippet ?? '(legacy campsite state without snippet context)',
        legacy: true
      };

      finding.id = fingerprint(finding);
      findings.push(finding);
    }
  } else if (state.phrases) {
    for (const phrase of state.phrases) {
      const finding = {
        kind: 'dismissive',
        source: 'response',
        phrase,
        offset: 0,
        snippet: '(legacy campsite state without snippet context)',
        legacy: true
      };

      finding.id = fingerprint(finding);
      findings.push(finding);
    }
  }

  if (state.failures) {
    for (const f of state.failures) {
      const finding = {
        kind: 'verification',
        source: 'tool',
        command: f.command,
        cwd: f.cwd ?? '',
        toolUseId: f.toolUseId ?? '',
        failureType: f.failureType,
        error: f.error,
        legacy: true
      };

      finding.id = fingerprint(finding);
      findings.push(finding);
    }
  } else if (state.unresolved && state.command) {
    const finding = {
      kind: 'verification',
      source: 'tool',
      command: state.command,
      cwd: '',
      toolUseId: '',
      failureType: state.failureType ?? 'error',
      error: state.error ?? 'unknown verification failure',
      legacy: true
    };

    finding.id = fingerprint(finding);
    findings.push(finding);
  }

  return findings;
}

// ── Detection primitives ────────────────────────────────────────────

/**
 * Collect every occurrence of one dismissive phrase from a text block
 * using a token-boundary regex.
 *
 * @param {string} text - Agent text.
 * @param {string} phrase - One dismissive phrase.
 * @param {string} source - Source label.
 * @param {number} radius - Snippet excerpt radius in characters.
 * @returns {object[]} Raw hits with `length` preserved for overlap collapsing.
 */
function collect(text, phrase, source, radius) {
  const hits = [];
  const regex = pattern(phrase);

  for (const match of text.matchAll(regex)) {
    const offset = match.index + match[1].length;

    hits.push({
      kind: 'dismissive',
      source,
      phrase,
      offset,
      length: match[2].length,
      snippet: excerpt(text, offset, match[2].length, radius),
      timestamp: Date.now()
    });
  }

  return hits;
}

/**
 * Collapse overlapping hits, preferring the most specific phrase when
 * multiple phrases cover the same text span.
 *
 * @param {object[]} hits - Raw candidate hits.
 * @returns {object[]} Deduplicated hits with `length` preserved.
 */
function collapse(hits) {
  const sorted = [...hits].sort(function compare(a, b) {
    return a.offset - b.offset || b.length - a.length || a.phrase.localeCompare(b.phrase);
  });
  const kept = [];

  for (const hit of sorted) {
    const last = kept.at(-1);

    if (last && last.offset + last.length > hit.offset) {
      continue;
    }

    kept.push(hit);
  }

  return kept;
}

// ── Analytical-context filter (stage 2) ─────────────────────────────

/**
 * Test whether a candidate phrase match is analytical or meta-discussion
 * rather than genuine dismissal.
 *
 * Returns true when the match is inside backtick-quoted code, wrapped in
 * quotation marks as a concept reference, or surrounded by meta-language
 * about detection, flagging, or historical findings.
 *
 * @param {string} text - Full agent text.
 * @param {number} offset - Start of the matched phrase.
 * @param {number} length - Length of the matched phrase.
 * @param {object} config - Detection config slice.
 * @returns {boolean} True when the match should be rejected.
 */
export function analytical(text, offset, length, config) {
  const scanRadius = config?.backtickScanRadius ?? DEFAULTS.backtickScanRadius;
  const quoteLook = config?.quoteLookaround ?? DEFAULTS.quoteLookaround;

  return (
    backticked(text, offset, length, scanRadius) ||
    quoted(text, offset, length, quoteLook) ||
    meta(text, offset, config)
  );
}

/**
 * Test whether the match sits inside a backtick-delimited span.
 *
 * @param {string} text - Full agent text.
 * @param {number} offset - Start of the matched phrase.
 * @param {number} length - Length of the matched phrase.
 * @param {number} radius - How far to scan for backtick delimiters.
 * @returns {boolean} True when inside backticks.
 */
function backticked(text, offset, length, radius) {
  const before = text.slice(Math.max(0, offset - radius), offset);
  const after = text.slice(offset + length, Math.min(text.length, offset + length + radius));

  const fenceBefore = (before.match(/```/g) ?? []).length;
  const fenceAfter = (after.match(/```/g) ?? []).length;

  if (fenceBefore % 2 === 1 && fenceAfter >= 1) {
    return true;
  }

  const tickBefore = (before.match(/(?<!`)`(?!`)/g) ?? []).length;
  const tickAfter = (after.match(/(?<!`)`(?!`)/g) ?? []).length;

  return tickBefore % 2 === 1 && tickAfter >= 1;
}

/**
 * Test whether the match is wrapped in quotation marks as a concept
 * reference rather than natural speech.
 *
 * @param {string} text - Full agent text.
 * @param {number} offset - Start of the matched phrase.
 * @param {number} length - Length of the matched phrase.
 * @param {number} lookaround - Characters before/after to scan for quote spans.
 * @returns {boolean} True when the phrase is quote-wrapped.
 */
function quoted(text, offset, length, lookaround) {
  const start = Math.max(0, offset - lookaround);
  const end = Math.min(text.length, offset + length + lookaround);
  const before = text.slice(start, offset);
  const after = text.slice(offset + length, end);

  if (/["']\s*$/.test(before) && /^\s*["']/.test(after)) {
    return true;
  }

  const beforeCount = (text.slice(0, offset).match(/["“”]/g) ?? []).length;
  const afterCount = (text.slice(offset + length).match(/["“”]/g) ?? []).length;

  return beforeCount % 2 === 1 && afterCount >= 1;
}

/**
 * Test whether the surrounding context contains meta-language tokens
 * that indicate analytical discussion rather than genuine dismissal.
 *
 * @param {string} text - Full agent text.
 * @param {number} offset - Start of the matched phrase.
 * @param {object} config - Detection config slice.
 * @returns {boolean} True when surrounding context is meta-discussion.
 */
function meta(text, offset, config) {
  const tokens = config?.metaTokens ?? DEFAULTS.metaTokens;
  const threshold = config?.metaTokenThreshold ?? DEFAULTS.metaTokenThreshold;
  const fallback = config?.metaParagraphFallback ?? DEFAULTS.metaParagraphFallback;
  const window = paragraph(text, offset, fallback).toLowerCase();

  let count = 0;

  for (const token of tokens) {
    if (window.includes(token)) {
      count++;

      if (count >= threshold) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract the paragraph surrounding an offset.
 *
 * Looks for double-newline boundaries (blank lines) that separate
 * paragraphs.  Falls back to `fallback` character radius when no
 * boundary is found within range.
 *
 * @param {string} text - Full agent text.
 * @param {number} offset - Position within the text.
 * @param {number} fallback - Character radius when no paragraph boundary is found.
 * @returns {string} The surrounding paragraph text.
 */
function paragraph(text, offset, fallback) {
  const before = text.lastIndexOf('\n\n', offset);
  const after = text.indexOf('\n\n', offset);

  if (before !== -1 || after !== -1) {
    const start = before === -1 ? Math.max(0, offset - fallback) : before + 2;
    const end = after === -1 ? Math.min(text.length, offset + fallback) : after;

    return text.slice(start, end);
  }

  let start = offset - fallback;
  let end = offset + fallback;

  if (start < 0) {
    end = Math.min(text.length, end - start);
    start = 0;
  }

  if (end > text.length) {
    start = Math.max(0, start - (end - text.length));
    end = text.length;
  }

  return text.slice(start, end);
}

// ── Text utilities ──────────────────────────────────────────────────

/**
 * Build a token-boundary regex for one dismissive phrase.
 *
 * @param {string} phrase - One dismissive phrase.
 * @returns {RegExp} Global, case-insensitive matcher.
 */
function pattern(phrase) {
  const escaped = escapeRegex(phrase).replaceAll(' ', '\\s+');
  return new RegExp(`(^|[^a-z0-9-])(${escaped})(?=[^a-z0-9-]|$)`, 'gi');
}

/**
 * Extract a short snippet around a matched phrase.
 *
 * @param {string} text - Original agent text.
 * @param {number} offset - Start of the matched phrase.
 * @param {number} length - Length of the matched phrase.
 * @param {number} radius - Characters each side of the match.
 * @returns {string} Ellipsis-trimmed snippet.
 */
function excerpt(text, offset, length, radius) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + length + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';

  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/**
 * Extract and normalize the sentence containing a snippet for stable
 * fingerprinting.  Strips whitespace variations, punctuation noise,
 * and case so that minor reformatting does not change the finding ID.
 *
 * @param {string} snippet - Excerpt around the matched phrase.
 * @returns {string} Normalized sentence digest.
 */
function sentence(snippet) {
  return (snippet ?? '')
    .replace(/\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Escape literal text for safe embedding in a regex.
 *
 * @param {string} text - Raw text.
 * @returns {string} Regex-safe text.
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
