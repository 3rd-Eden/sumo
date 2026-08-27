/**
 * `store(ns)` — a plugin's scoped key-value handle (specs 01/03a §6). Built over the daemon client's
 * `get/put/del/scan`; the daemon owns LevelDB, so this is a thin keyspace wrapper.
 *
 * Keyspace contract (spec 01): `kv:<plugin>:<ns>:<key>`. To make the trust boundary real — so
 * `store('a')` can never see `store('b')`'s data, and a namespace that is a *prefix* of another
 * (`a` vs `a:b`) or that contains the `:` delimiter cannot bleed — the `plugin` and `ns` segments are
 * percent-encoded (`%`→`%25`, `:`→`%3A`) before composing the key. An encoded segment can never
 * contain the delimiter, so the `kv:<enc>:<enc>:` prefix is unambiguous; `scan` ranges over exactly
 * that prefix and strips it from returned keys so the plugin sees only its own leaf keys.
 *
 * @module sumo/plugin/store
 */

const KV = 'kv:';

/**
 * Percent-encode a key segment so it cannot contain the `:` delimiter (or a literal `%`).
 *
 * @access private
 * @param {string} seg - Seg supplied to `enc`.
 * @returns {string} String returned by `enc`.
 */
function enc(seg) {
  return String(seg).replace(/%/g, '%25').replace(/:/g, '%3A');
}

/**
 * Build a plugin-scoped store over the daemon client.
 *
 * @access public
 * @param {import('sumo/db').SumoDb} db - the SumoDb client (`get`/`put`/`del`/`scan`); typedef is internal to sumo/db
 * @param {string} plugin - the runtime's canonical plugin id ()
 * @param {string} ns - the namespace the plugin requested via `store(ns)`
 * @returns {import('./schema.mjs').Store} Import(' /schema mjs') store returned by `storage`.
 */
export function storage(db, plugin, ns) {
  const base = `${KV}${enc(plugin)}:${enc(ns)}:`; // closed over — a plugin cannot escape it

  return {
    /**
     * Execute `get`.
     *
     * @access public
     * @param {string} key - Key used by `get`.
     * @returns {Promise<unknown|undefined>} Promise resolving to the `get` result.
     */
    async get(key) {
      return db.get(base + key);
    }, /**
     * Execute `set`.
     *
     * @access public
     * @param {string} key - Key used by `set`.
     * @param {unknown} value - Value to resolve.
     * @param {{ ttlMs?: number }} opts - Options read by this operation.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async set(key, value, opts = {}) {
      await db.put(base + key, value, opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {});
    }, /**
     * Execute `del`.
     *
     * @access public
     * @param {string} key - Key used by `del`.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async del(key) {
      await db.del(base + key);
    }, /**
     * Iterate `[key, value]` for keys under `prefix` within this namespace. Keys are returned with
     * the `kv:<plugin>:<ns>:` prefix stripped, so the plugin sees only its own leaf keys.
     *
     * @access public
     * @param {string} prefix - Prefix used by `scan`.
     * @returns {AsyncIterable<[string, unknown]>} Async iterator produced by `scan`.
     */
    async *scan(prefix = '') {
      for await (const [key, value] of db.scan(base + prefix)) {
        yield [key.slice(base.length), value];
      }
    }, /**
     * Atomic read-merge-write for a key in this namespace. Routes through the daemon's single write
     * serializer so concurrent `merge()` calls to the same key never lose-update each other (unlike a
     * client-side read-modify-write over `get`/`set`). Uses the same deep-merge semantics as `mergeDoc`
     * on `ses:` documents: patch wins per key; present values not in patch are preserved.
     *
     * @access public
     * @param {string} key - Key used by `merge`.
     * @param {Record<string, unknown>} patch - Patch supplied to `merge`.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async merge(key, patch) {
      await db.mergeDoc(base + key, patch);
    }

    // NOTE: `search` (03a §6 Store) is intentionally NOT implemented here. The daemon's FTS index
    // (`db.search`) is global and cannot be scoped to a single `kv:<plugin>:<ns>:` partition, so a
    // namespaced `store.search` would either leak cross-namespace hits or fake scoping. It is deferred
    // until the db layer can scope FTS — declaring the gap honestly rather than faking it (§3b/§3c).
  };
}
