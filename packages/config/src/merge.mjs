/**
 * Config-layer merge (spec 06 "Merge semantics" / CONVENTIONS §3b). Layering is a merge problem, so
 * it uses the same replace-vs-merge discipline as the rest of the system — with the **one sanctioned
 * config-only exception**, the `use:` array's `~name` disable.
 *
 * This is deliberately NOT `lodash.defaultsdeep` (the `sumo/db` event-merge primitive): that one is
 * fill-gaps / first-writer-wins / arrays-by-index, the inverse of what config layering needs. Config
 * is **last-writer-wins**, **arrays concat+dedupe**, plus the `use:` `~name` disable — a deliberate
 * divergence the spec sanctions, so it lives here as a small focused function.
 *
 * @module sumo/config/merge
 */

import stringify from 'safe-stable-stringify';
import { isPlainObject } from 'sumo/util';

/** The plugin list key, which gets the `~name` disable treatment instead of plain array merge. */
const USE_KEY = 'use';

/**
 * Concatenate two arrays and drop structural duplicates, preserving first-seen (earlier-layer) order.
 *
 * @access private
 * @param {Array<unknown>} earlier - Earlier supplied to `mergeArray`.
 * @param {Array<unknown>} later - Later supplied to `mergeArray`.
 * @returns {Array<unknown>} List produced by `mergeArray`.
 */
function mergeArray(earlier, later) {
  /** @type {Array<unknown>} */
  const out = [];
  const seen = new Set();
  for (const item of [...earlier, ...later]) {
    const key = stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Merge the `use:` plugin list with the `~name` disable exception (spec 06): a later entry `~foo`
 * removes a `foo` an earlier layer enabled; a plain name is added (deduped, first-seen order). An
 * unmatched `~name` is a no-op.
 *
 * @access private
 * @param {string[]} earlier - Earlier supplied to `mergeUse`.
 * @param {string[]} later - Later supplied to `mergeUse`.
 * @returns {string[]} List produced by `mergeUse`.
 */
function mergeUse(earlier, later) {
  /** @type {string[]} */
  const out = [];
  for (const name of earlier) if (!out.includes(name)) out.push(name);
  for (const entry of later) {
    if (typeof entry === 'string' && entry.startsWith('~')) {
      const target = entry.slice(1);
      const at = out.indexOf(target);
      if (at !== -1) out.splice(at, 1);
      continue;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Merge one config layer over another (pairwise, `later` wins). Objects deep-merge, scalars and
 * type-mismatches replace, arrays concat+dedupe, and the top-level `use:` key gets `~name` handling.
 * Neither input is mutated.
 *
 * @access public
 * @param {Record<string, unknown>} earlier - Earlier supplied to `mergeConfig`.
 * @param {Record<string, unknown>} later - Later supplied to `mergeConfig`.
 * @returns {Record<string, unknown>} Structured output from `mergeConfig`.
 */
export function mergeConfig(earlier, later) {
  if (earlier === undefined) return structuredClone(later);
  if (later === undefined) return structuredClone(earlier);

  // Non-object at the top is unusual for config layers, but keep the rule total: later replaces.
  if (!isPlainObject(earlier) || !isPlainObject(later)) return structuredClone(later);

  const out = structuredClone(earlier);
  for (const [key, lv] of Object.entries(later)) {
    const ev = out[key];
    if (key === USE_KEY && Array.isArray(ev) && Array.isArray(lv)) {
      out[key] = mergeUse(ev, lv);
    } else if (Array.isArray(ev) && Array.isArray(lv)) {
      out[key] = mergeArray(ev, lv);
    } else if (isPlainObject(ev) && isPlainObject(lv)) {
      out[key] = mergeConfig(ev, lv);
    } else {
      out[key] = structuredClone(lv);
    }
  }
  return out;
}

/**
 * Fold an ordered list of config layers (earliest first) into one merged config.
 *
 * @access public
 * @param {Array<Record<string, unknown>>} layers - Layers supplied to `mergeChain`.
 * @returns {Record<string, unknown>} Structured output from `mergeChain`.
 */
export function mergeChain(layers) {
  return layers.reduce((acc, layer) => mergeConfig(acc, layer), {});
}
