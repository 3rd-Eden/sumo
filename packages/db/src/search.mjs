/**
 * Full-text search over the log (spec 01 §"Search"). LevelDB has no query engine, so the daemon
 * maintains a `minisearch` (pure-JS) index. For 1.0 it is held in memory and rebuilt on daemon
 * start from `evt:`; incremental `idx:fts:` persistence is deferred (Rule 6). The swap point is this
 * one module if full-text ever outgrows the in-process index.
 *
 * @module sumo/db/search
 */

import MiniSearch from 'minisearch';
import { evtKey, prefixRange, PREFIX } from './keyspace.mjs';

/**
 * @typedef {import('./eventlog.mjs').StoredEvent} StoredEvent
 * @typedef {{ index: (event: StoredEvent) => void, rebuild: () => Promise<void>, query: (q: string, opts?: { limit?: number }) => Promise<Array<{ docref: string, score: number }>> }} SearchIndex
 */

/**
 * Extract the searchable text from a normalized event payload.
 *
 * @access private
 * @param {StoredEvent} event - Stored event whose payload contributes searchable text.
 * @returns {string} String returned by `textOf`.
 */
function textOf(event) {
  const p = event.payload ?? {};
  return [p.text, p.output, p.prompt, p.status].filter((v) => typeof v === 'string').join(' ');
}

/**
 * Create the in-memory event search index.
 *
 * @access public
 * @param {import('./eventlog.mjs').AbstractDb} db - opened with `valueEncoding: 'json'`
 * @returns {SearchIndex} In-memory full-text index bound to the event log.
 */
export function createSearch(db) {
  const ms = new MiniSearch({ idField: 'docref', fields: ['text', 'type'], storeFields: [] });

  /**
   * Add (or replace) the index entry for a stored event.
 *
 * @access public
 * @param {StoredEvent} event - Stored event to add to the search index.
 * @returns {void} Completes without producing a value.
 */
  function index(event) {
    const docref = evtKey(event.seq);
    if (ms.has(docref)) ms.replace({ docref, text: textOf(event), type: event.type });
    else ms.add({ docref, text: textOf(event), type: event.type });
  }

  /**
   * Rebuild the whole index from the event log (called on daemon start).
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function rebuild() {
    const docs = [];
    for await (const [, event] of db.iterator(prefixRange(PREFIX.evt))) {
      const stored = /** @type {StoredEvent} */ (event);
      docs.push({ docref: evtKey(stored.seq), text: textOf(stored), type: stored.type });
    }
    if (ms.documentCount) ms.removeAll();
    ms.addAll(docs);
  }

  /**
   * Search the in-memory event index for text matches.
   *
   * @access public
   * @param {string} q - Search query text.
   * @param {{ limit?: number }} opts - Maximum number of hits to return.
   * @returns {Promise<Array<{ docref: string, score: number }>>} Search hits ordered by relevance.
   */
  async function query(q, { limit = 20 } = {}) {
    return ms.search(q, { prefix: true }).slice(0, limit).map((r) => ({ docref: r.id, score: r.score }));
  }

  return { index, rebuild, query };
}
