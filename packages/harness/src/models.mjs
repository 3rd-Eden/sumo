/**
 * Dynamic model tiers for harness adapters.
 *
 * Tiers are picked from a harness's real model list. No concrete model id is a default here: adapters
 * expose `list()`, this module ranks that list, and `resolve()` turns `fast`/`balanced`/`powerful`
 * into one distinct model id.
 *
 * @module sumo/harness/models
 */

export const TIERS = /** @type {const} */ (['fast', 'balanced', 'powerful']);

const TIER_SET = new Set(TIERS);
const MINI = /\b(mini|nano|small|lite)\b/i;
const FAST = /\b(fast|cheap|cost-efficient|efficient|simple|smaller|small)\b/i;
const POWER = /\b(frontier|powerful|complex|research|pro|strongest|advanced)\b/i;
const MID = /\b(balanc|everyday|standard|versatile|strong)\b/i;

/**
 * @typedef {'fast'|'balanced'|'powerful'} Tier
 * @typedef {object} Model
 * @property {string} id
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [provider]
 * @property {number} [version]
 * @property {number} [priority]
 * @property {unknown} [raw]
 * @typedef {Model & { speed: number, balance: number, power: number }} Ranked
 * @typedef {{ fast?: string, balanced?: string, powerful?: string }} Pick
 */

/**
 * Return whether a value names a portable tier.
 *
 * @access public
 * @param {unknown} value - Value inspected by `tier`.
 * @returns {value is Tier} Whether the value is a tier.
 */
export function tier(value) {
  return typeof value === 'string' && TIER_SET.has(/** @type {Tier} */ (value));
}

/**
 * Ask an adapter for its model list.
 *
 * @access public
 * @param {{ list?: () => Promise<unknown>|unknown, id?: string }} adapter - Harness adapter.
 * @returns {Promise<{ status: 'available'|'unavailable', models: Model[], reason?: string }>} Normalized list result.
 */
export async function list(adapter) {
  if (typeof adapter.list !== 'function') {
    return {
      status: 'unavailable',
      models: [],
      reason: `${adapter.id ?? 'harness'} does not expose list()`
    };
  }
  try {
    const out = await adapter.list();
    if (!out || typeof out !== 'object') {
      return {
        status: 'unavailable',
        models: [],
        reason: `${adapter.id ?? 'harness'} returned no models`
      };
    }
    const r = /** @type {Record<string, unknown>} */ (out);
    const models = Array.isArray(r.models) ? modelsOf(r.models) : [];
    if (r.status === 'unavailable') {
      return {
        status: 'unavailable',
        models,
        reason: typeof r.reason === 'string' ? r.reason : 'models unavailable'
      };
    }
    if (models.length === 0) {
      return {
        status: 'unavailable',
        models: [],
        reason: typeof r.reason === 'string' ? r.reason : 'no models available'
      };
    }
    return {
      status: 'available',
      models
    };
  } catch (err) {
    return {
      status: 'unavailable',
      models: [],
      reason: /** @type {Error} */ (err).message
    };
  }
}

/**
 * Normalize one model-like value.
 *
 * @access public
 * @param {unknown} value - Model-like value.
 * @returns {Model|null} Normalized model.
 */
export function model(value) {
  if (!value || typeof value !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (value);
  const id = string(r.id ?? r.slug ?? r.model ?? r.modelId);
  if (!id) return null;
  const name = string(r.name ?? r.display_name ?? r.displayName);
  const description = string(r.description);
  const text = `${id} ${name ?? ''} ${description ?? ''}`;
  const inferredVersion = version(text);
  return {
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(string(r.provider) ? { provider: string(r.provider) } : {}),
    version: inferredVersion,
    ...(number(r.priority) !== undefined ? { priority: number(r.priority) } : {}),
    raw: value
  };
}

/**
 * Rank models for tier picking.
 *
 * @access public
 * @param {unknown[]} models - Models to rank.
 * @returns {Ranked[]} Ranked models.
 */
export function rank(models) {
  return modelsOf(models).map((m) => {
    const text = `${m.id} ${m.name ?? ''} ${m.description ?? ''}`;
    const v = /** @type {number} */ (m.version);
    const mini = MINI.test(text);
    const fast = FAST.test(text);
    const power = POWER.test(text);
    const mid = MID.test(text);
    return {
      ...m,
      speed: (mini ? 80 : 0) + (fast ? 25 : 0) - (power ? 20 : 0) + v / 10_000,
      power: v + (power ? 60 : 0) + (mid ? 10 : 0) - (mini ? 35 : 0) - (typeof m.priority === 'number' ? m.priority / 100 : 0),
      balance: v + (mid ? 50 : 0) - (mini ? 40 : 0) - (power ? 15 : 0) - (typeof m.priority === 'number' ? m.priority / 100 : 0)
    };
  });
}

/**
 * Normalize and remove invalid model rows.
 *
 * @access private
 * @param {unknown[]} values - Model-like values.
 * @returns {Model[]} Valid models.
 */
function modelsOf(values) {
  /** @type {Model[]} */
  const out = [];
  for (const value of values) {
    const row = model(value);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Pick distinct tier models from a ranked model list.
 *
 * @access public
 * @param {unknown[]} models - Candidate models.
 * @returns {Pick} Tier picks.
 */
export function pick(models) {
  const rows = rank(models);
  /** @type {Pick} */
  const out = {};
  const used = new Set();
  const fast = best(rows, used, 'speed')?.id;
  if (fast) {
    out.fast = fast;
    used.add(fast);
  }
  const powerful = best(rows, used, 'power')?.id;
  if (powerful) {
    out.powerful = powerful;
    used.add(powerful);
  }
  if (rows.length >= 3) {
    const balanced = best(rows, used, 'balance')?.id;
    if (balanced) out.balanced = balanced;
  }
  return out;
}

/**
 * Resolve a requested exact model id or tier.
 *
 * @access public
 * @param {string|undefined} requested - Requested model value.
 * @param {{ list?: () => Promise<unknown>|unknown, id?: string }} adapter - Harness adapter.
 * @returns {Promise<{ ok: true, model?: string, tier?: Tier, requested?: string } | { ok: false, code: 'SUMO_MODEL_NOT_FOUND', reason: string }>} Resolution result.
 */
export async function resolve(requested, adapter) {
  if (!requested) {
    return {
      ok: true
    };
  }
  if (!tier(requested)) {
    return {
      ok: true,
      model: requested
    };
  }
  const r = await list(adapter);
  if (r.status !== 'available') {
    return {
      ok: false,
      code: 'SUMO_MODEL_NOT_FOUND',
      reason: `${adapter.id ?? 'harness'} models unavailable: ${r.reason}`
    };
  }
  const picked = pick(r.models);
  const chosen = picked[requested];
  if (!chosen) {
    return {
      ok: false,
      code: 'SUMO_MODEL_NOT_FOUND',
      reason: `${adapter.id ?? 'harness'} cannot assign '${requested}' from ${r.models.length} model(s)`
    };
  }
  return {
    ok: true,
    model: chosen,
    tier: requested,
    requested
  };
}

/**
 * Return a trimmed string only when a native model field is non-empty.
 *
 * @access private
 * @param {unknown} value - Native field value to read.
 * @returns {string|undefined} Trimmed string value, when present.
 */
function string(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Return a finite number only when a native model field is numeric.
 *
 * @access private
 * @param {unknown} value - Native field value to read.
 * @returns {number|undefined} Finite numeric value, when present.
 */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Select the highest-scoring unused model for one scoring axis.
 *
 * @access private
 * @param {Ranked[]} rows - Ranked model candidates.
 * @param {Set<string>} used - Model ids already assigned to another tier.
 * @param {'speed'|'balance'|'power'} key - Score axis used for ordering.
 * @returns {Ranked|undefined} Best available ranked row, when any remain.
 */
function best(rows, used, key) {
  return rows
    .filter((row) => !used.has(row.id))
    .sort((a, b) => b[key] - a[key] || /** @type {number} */ (b.version) - /** @type {number} */ (a.version) || a.id.localeCompare(b.id))[0];
}

/**
 * Convert the first version-like number in model text into a sortable score.
 *
 * @access private
 * @param {string} text - Searchable model text.
 * @returns {number} Numeric version score.
 */
function version(text) {
  const nums = [...text.matchAll(/\d+(?:\.\d+){0,2}/g)].map((m) => m[0]);
  if (nums.length === 0) return 0;
  const parts = nums[0].split('.').map((n) => Number(n));
  return (parts[0] ?? 0) * 10_000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
}
