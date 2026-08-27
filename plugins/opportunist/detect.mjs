/**
 * Deterministic finding detection for the `opportunist` plugin.
 *
 * This is intentionally local to the plugin. The old campsite rule is reference material only; this
 * module carries forward the useful detector behavior without importing or preserving the old package
 * shape.
 *
 * @module sumo/plugins/opportunist/detect
 */
/* eslint-disable jsdoc/match-description, jsdoc/require-param-description, jsdoc/require-returns-description */

import { createHash } from 'node:crypto';

/** Phrases that indicate an agent may be stepping over a discovered issue. */
export const PHRASES = Object.freeze([
  'pre-existing',
  'pre existing',
  'existing failure',
  'existing failing',
  'known failure',
  'known failing',
  'legacy failure',
  'legacy failing',
  'not related to',
  'not related to our',
  'not related to my',
  'not caused by',
  'an unrelated',
  'is unrelated',
  'unrelated to our',
  'unrelated to my',
  'outside my change',
  'outside my changes',
  'outside this task',
  'separate concern',
  'separate issue',
  'out of scope',
  'not my task',
  'not part of this',
  'not part of my',
  'was not modified',
  'were not modified',
  'was not changed',
  'did not modify',
  'someone else owns',
  'i will mention it later',
  'mention it in the final',
  'mention it later'
]);

/** @typedef {{ kind: 'dismissive', source: string, phrase: string, snippet: string, offset: number, length: number }} Candidate */
/** @typedef {{ id: string, kind: 'dismissive', source: string, sessionId?: string, phrase: string, snippet: string, offset: number, sourceEventSeq?: number, createdAt: number }} DismissiveFinding */

/**
 * Detect dismissive-language findings in one text block.
 *
 * @access public
 * @param {{ text?: string, source: string, sessionId?: string, sourceEventSeq?: number, now?: number }} input
 * @returns {DismissiveFinding[]} Findings whose ids are stable for the same session/phrase/snippet.
 */
export function detectText({ text = '', source, sessionId, sourceEventSeq, now = Date.now() }) {
  const raw = [];
  for (const phrase of PHRASES) raw.push(...collect(text, phrase, source));
  return collapse(raw)
    .filter((hit) => !analytical(text, hit.offset, hit.length))
    .map((hit) => {
      const { length: _length, ...record } = hit;
      return {
        ...record,
        sessionId,
        sourceEventSeq,
        createdAt: now,
        id: fingerprint({ ...record, sessionId })
      };
    });
}

/**
 * Generate a stable finding id.
 *
 * @access public
 * @param {{ kind?: string, source?: string, sessionId?: string, phrase?: string, snippet?: string, command?: string }} finding
 * @returns {string} A short deterministic id.
 */
export function fingerprint(finding) {
  const parts =
    finding.kind === 'verification'
      ? [finding.kind, finding.sessionId ?? '', finding.command ?? '']
      : [finding.kind ?? 'dismissive', finding.sessionId ?? '', finding.source ?? '', finding.phrase ?? '', sentence(finding.snippet ?? '')];
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/**
 * Build a verification finding id from a failed command.
 *
 * @access public
 * @param {{ sessionId?: string, command: string }} input
 * @returns {string} Stable verification finding id.
 */
export function verificationId(input) {
  return fingerprint({ kind: 'verification', sessionId: input.sessionId, command: input.command });
}

/**
 * Collect candidate phrase matches.
 *
 * @access private
 * @param {string} text
 * @param {string} phrase
 * @param {string} source
 * @returns {Candidate[]}
 */
function collect(text, phrase, source) {
  const hits = /** @type {Candidate[]} */ ([]);
  const regex = pattern(phrase);
  for (const match of text.matchAll(regex)) {
    const offset = (match.index ?? 0) + match[1].length;
    hits.push({
      kind: /** @type {'dismissive'} */ ('dismissive'),
      source,
      phrase,
      offset,
      length: match[2].length,
      snippet: excerpt(text, offset, match[2].length)
    });
  }
  return hits;
}

/**
 * Build a token-boundary phrase matcher.
 *
 * @access private
 * @param {string} phrase
 * @returns {RegExp}
 */
function pattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-zA-Z0-9_-])(${escaped})(?=$|[^a-zA-Z0-9_-])`, 'gi');
}

/**
 * Collapse overlapping phrase matches, keeping the longest phrase.
 *
 * @access private
 * @param {Candidate[]} hits
 * @returns {Candidate[]}
 */
function collapse(hits) {
  const sorted = [...hits].sort((a, b) => a.offset - b.offset || b.length - a.length || a.phrase.localeCompare(b.phrase));
  const kept = /** @type {Candidate[]} */ ([]);
  for (const hit of sorted) {
    const last = kept.at(-1);
    if (!last || hit.offset >= last.offset + last.length) kept.push(hit);
  }
  return kept;
}

/**
 * Return whether the phrase appears in quoted, fenced, or detector-meta context.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @param {number} length
 * @returns {boolean}
 */
function analytical(text, offset, length) {
  if (insideFence(text, offset) || insideInlineCode(text, offset)) return true;
  if (quoted(text, offset, length)) return true;
  const para = paragraph(text, offset).toLowerCase();
  if (/\b(opportunist|campsite|dismissive phrase|detector|false positive|flagged by)\b/.test(para)) return true;
  return false;
}

/**
 * Test for an open markdown code fence before the offset.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @returns {boolean}
 */
function insideFence(text, offset) {
  const before = text.slice(0, offset);
  const fences = before.match(/^```/gm);
  return Boolean(fences && fences.length % 2 === 1);
}

/**
 * Test for a backtick pair around the offset on the same line.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @returns {boolean}
 */
function insideInlineCode(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const local = offset - lineStart;
  return line.lastIndexOf('`', local) !== -1 && line.indexOf('`', local) !== -1;
}

/**
 * Test for simple quote wrapping around the matched phrase.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @param {number} length
 * @returns {boolean}
 */
function quoted(text, offset, length) {
  const before = text.slice(Math.max(0, offset - 4), offset);
  const after = text.slice(offset + length, offset + length + 4);
  return /["'“‘]$/.test(before.trimEnd()) && /^["'”’]/.test(after.trimStart());
}

/**
 * Return the paragraph surrounding an offset.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
function paragraph(text, offset) {
  const before = text.lastIndexOf('\n\n', offset);
  const after = text.indexOf('\n\n', offset);
  return text.slice(before === -1 ? 0 : before + 2, after === -1 ? text.length : after);
}

/**
 * Return a compact snippet around a phrase.
 *
 * @access private
 * @param {string} text
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function excerpt(text, offset, length) {
  const radius = 120;
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a snippet for identity.
 *
 * @access private
 * @param {string} snippet
 * @returns {string}
 */
function sentence(snippet) {
  return snippet.toLowerCase().replace(/\s+/g, ' ').trim();
}
