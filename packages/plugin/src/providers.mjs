/**
 * Provider-side registration + the `run` provider path (specs 03 "harness/messenger verbs", 03a §7).
 *
 * A harness/messenger adapter is contributed via `sumo.harness(name, impl)` / `sumo.messenger(name,
 * impl)`, where `impl` is a factory `(ctx) => adapter`. The factory receives a build-context that
 * carries the adapter's validated `config`, an adapter-scoped `store`, and the **builders** it uses
 * to construct objects with methods bound to their origin (`hctx.session`, `mctx.work`/`message`/
 * `thread`) — the scoped provider "hand the plugin pre-bound, scoped verbs" pattern at the adapter
 * boundary, so a downstream consumer never names an adapter.
 *
 * No real adapter is built here until selection. `run`, with no registered or available harness,
 * returns the aligned capability-failure `Result` (`SUMO_NO_HARNESS`) surfaced as a diagnostic —
 * never a throw, never a fake backend (CONVENTIONS §3b/§3c). The `Session` it would return is the
 * typed 03a contract; its construction is the harness layer's job.
 *
 * @module sumo/plugin/providers
 */

import { ok, fail } from './schema.mjs';
import { SumoError } from 'sumo/error';
import { classify } from 'sumo/harness/classify';

const PREFERRED_HARNESSES = ['claude-code', 'codex', 'copilot', 'cursor'];

/**
 * @typedef {object} HarnessRunOptions
 * @property {string} [harness] Requested harness id.
 * @property {string} [resume] Native resume id; disables cross-harness fallback because ids are
 * harness-specific.
 * @property {boolean} [__sumoExactHarness] Internal orchestrator marker for attempting exactly the
 * named harness after the orchestrator has expanded its own fallback candidates.
 */

/**
 * @typedef {object} RuntimeHarnessConfig
 * @property {string} [default] Configured default harness id.
 * @property {string[]} fallback Configured fallback harness ids, in order.
 */

/**
 * @typedef {object} HarnessSelectionFailure
 * @property {string} id Candidate harness id.
 * @property {string} reason Why the candidate could not be used.
 */

/**
 * @typedef {object} HarnessSelection
 * @property {string} [name] Selected harness id.
 * @property {HarnessSelectionFailure[]} unavailable Candidates rejected while selecting a harness.
 */

/**
 * @typedef {object} ProviderRegistry
 * @property {(name: string, impl: unknown) => void} harness - Register a harness provider factory.
 * @property {(name: string, impl: unknown) => void} messenger - Register a messenger provider factory.
 * @property {(prompt: string, opts?: HarnessRunOptions) => Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>} run - Spawn a session through the selected harness.
 * @property {() => Array<{ name: string, adapter: unknown }>} instantiateMessengers - Instantiate every registered messenger.
 * @property {() => boolean} hasHarness - Whether any harness provider is registered.
 * @property {() => boolean} hasMessenger - Whether any messenger provider is registered.
 * @property {(name: string) => boolean} hasHarnessName - Whether a harness provider exists by name.
 * @property {(name: string) => boolean} hasMessengerName - Whether a messenger provider exists by name.
 * @property {() => Map<string, Function>} harnessFactories - Copy of registered harness factories for capability introspection.
 * @property {(name: string, kind: 'harness'|'messenger') => Record<string, unknown>} buildContext - Build an adapter factory context.
 */

/**
 * Create the providers registry.
 *
 * @access public
 * @param {{ adapterStore?: (namespace: string) => import('./schema.mjs').Store, configFor?: (name: string) => Record<string, unknown>, onError?: (err: unknown, meta?: object) => void, signal?: AbortSignal, db?: import('sumo/db').SumoDb }} opts - Provider registry dependencies.
 * @returns {ProviderRegistry} Provider registry used by the plugin runtime.
 */
export function providers({ adapterStore = () => /** @type {import('./schema.mjs').Store} */ ({}), configFor = () => ({}), onError = () => {}, signal, db } = {}) {
  /** @type {Map<string, Function>} */
  const harnessFactories = new Map();
  /** @type {Map<string, Function>} */
  const messengerFactories = new Map();

  /**
   * Build the context handed to an adapter factory: its config, an adapter-scoped store, and the
   * object builders that bind methods onto produced objects.
   *
   * @access public
   * @param {string} name - Name used by `buildCtx`.
   * @param {'harness'|'messenger'} kind - Kind used by `buildCtx`.
   * @returns {Record<string, unknown>} Adapter factory context for the requested provider kind.
   */
  function buildCtx(name, kind) {
    const config = configFor(name);
    const store = adapterStore(`${kind}:${name}`);
    if (kind === 'harness') {
      // hctx.session(spec): the adapter binds control methods (send/key/done/…) onto the Session.
      // `db` is the daemon client the harness base appends normalized events through (daemon stays the
      // sole LevelDB writer; the harness is a client, not an owner).
      return {
        config,
        store,
        signal,
        db,
        /**
         * Build the Session seed object that harness adapters bind controls onto.
         *
         * @access public
         * @param {Record<string, unknown>} spec - Object fields used to build the normalized value.
         * @returns {Record<string, unknown>} Structured output from `session`.
         */
        session(spec) {
          return ({ state: 'starting', capabilities: {}, ...spec });
        }
      };
    }
    // mctx: builders for the messenger's produced objects. `signal` aborts on runtime shutdown so a
    // long-running ingress can break its loop cooperatively. `db` is the daemon client the messenger
    // base appends `work.*`/`messenger.*` events through and subscribes/reads for the proof-of-life
    // path (the daemon stays the sole LevelDB writer; the messenger is a client, like the harness —
    // its hctx carries `db` for the same reason). `name` is the registration name for event provenance.
    return {
      config,
      store,
      signal,
      db,
      name,
      /**
       * Build a messenger work item with Sumo's default optional fields.
       *
       * @access public
       * @param {Record<string, unknown>} spec - Object fields used to build the normalized value.
       * @returns {Record<string, unknown>} Structured output from `work`.
       */
      work(spec) { return ({ ext: {}, can: {}, ...spec }); },

      /**
       * Build a messenger message object without adding policy.
       *
       * @access public
       * @param {Record<string, unknown>} spec - Object fields used to build the normalized value.
       * @returns {Record<string, unknown>} Structured output from `message`.
       */
      message(spec) { return ({ ...spec }); },

      /**
       * Build a thread object with an honest unsupported reaction default.
       *
       * @access public
       * @param {Record<string, unknown>} spec - Object fields used to build the normalized value.
       * @returns {Record<string, unknown>} Structured output from `thread`.
       */
      thread(spec) {
        return {
          /**
           * Report unsupported reactions unless the adapter supplies its own implementation.
           *
           * @access public
           * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `react`.
           */
          async react() {
            return fail('SUMO_CAP_UNSUPPORTED', 'reactions unsupported');
          },
          ...spec
        };
      }
    };
  }

  /**
   * Register a provider factory under a unique name (duplicate name is a programmer error → throw).
   *
   * @access public
   * @param {Map<string, Function>} into - Into supplied to `register`.
   * @param {string} kind - Kind used by `register`.
   * @param {string} name - Name used by `register`.
   * @param {unknown} impl - Candidate provider factory.
   * @returns {void} Registers the provider factory or throws for invalid input.
   */
  function register(into, kind, name, impl) {
    if (typeof name !== 'string' || !name) throw new SumoError({ name: 'plugin', method: 'provider', code: 'SUMO_INVALID_PROVIDER', message: `sumo.${kind}(name, impl): a non-empty name is required` });
    if (typeof impl !== 'function') throw new SumoError({ name: 'plugin', method: 'provider', code: 'SUMO_INVALID_PROVIDER', message: `sumo.${kind}('${name}', impl): impl must be a factory function` });
    if (into.has(name)) throw new SumoError({ name: 'plugin', method: 'provider', code: 'SUMO_DUPLICATE_REGISTRATION', message: `sumo.${kind}: '${name}' is already registered — select a unique name` });
    into.set(name, /** @type {Function} */ (impl));
  }

  /**
   * Register a harness provider factory.
   *
   * @access public
   * @param {string} name - Name used by `harness`.
   * @param {unknown} impl - Provider implementation to register.
   * @returns {void} Adds the harness provider to the registry.
   */
  function harness(name, impl) {
    register(harnessFactories, 'harness', name, impl);
  }

  /**
   * Register a messenger provider factory.
   *
   * @access public
   * @param {string} name - Name used by `messenger`.
   * @param {unknown} impl - Provider implementation to register.
   * @returns {void} Adds the messenger provider to the registry.
   */
  function messenger(name, impl) {
    register(messengerFactories, 'messenger', name, impl);
  }

  /**
   * Drop empty and duplicate harness ids while preserving first-seen candidate order.
   *
   * @access public
   * @param {Array<unknown>} ids - Candidate ids that may include optional config values.
   * @returns {string[]} Unique non-empty string ids in first-seen order.
   */
  function compactUnique(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * Read the resolved runtime harness config from the same root config slice adapters use.
   *
   * @access public
   * @returns {RuntimeHarnessConfig} Runtime harness config returned by `harnessConfig`.
   */
  function harnessConfig() {
    const harness = /** @type {Record<string, unknown>} */ (configFor('').harness ?? {});
    return {
      default: typeof harness.default === 'string' ? harness.default : undefined, fallback: Array.isArray(harness.fallback) ? harness.fallback.filter((/** @type {unknown} */ id) => typeof id === 'string' && id) : []
    };
  }

  /**
   * Resolve the ordered candidate ids for a run. `__sumoExactHarness` is an internal orchestrator
   * hook: the orchestrator has already expanded the fallback chain and needs this provider call to
   * attempt exactly one candidate.
   *
   * @access public
   * @param {HarnessRunOptions} opts - Harness selection options for a run.
   * @returns {string[]} Ordered candidate harness ids for this run.
   */
  function candidateIds(opts = {}) {
    const cfg = harnessConfig();
    const registered = [...harnessFactories.keys()];
    const remaining = registered.filter((id) => !PREFERRED_HARNESSES.includes(id));

    if (opts.__sumoExactHarness) return compactUnique([opts.harness]);

    if (opts.resume != null) {
      return compactUnique([opts.harness, cfg.default, registered.length === 1 ? registered[0] : undefined]);
    }

    if (opts.harness) {
      return compactUnique([opts.harness, ...cfg.fallback]);
    }

    return compactUnique([
    cfg.default,
      ...cfg.fallback,
      ...PREFERRED_HARNESSES,
      ...remaining
    ]);
  }

  /**
   * Select the first registered harness that does not prove itself unavailable.
   *
   * @access public
   * @param {HarnessRunOptions} opts - Harness selection options for a run.
   * @returns {Promise<HarnessSelection>} Promise resolving to the `selectHarness` result.
   */
  async function selectHarness(opts = {}) {
    const ids = candidateIds(opts);
    /** @type {Array<{id: string, reason: string}>} */
    const unavailable = [];
    if (!ids.length) return { unavailable };

    for (const id of ids) {
      const factory = harnessFactories.get(id);
      if (!factory) {
        unavailable.push({ id, reason: `no harness registered named '${id}'` });
        continue;
      }

      const adapter = factory(buildCtx(id, 'harness'));
      const probe = await adapter.available();
      if (probe.status === 'unavailable') {
        unavailable.push({ id, reason: probe.reason ?? 'unavailable' });
        continue;
      }
      return { name: id, unavailable };
    }

    return { unavailable };
  }

  /**
   * Format the user-facing diagnostic when every candidate is absent or unavailable.
   *
   * @access public
   * @param {HarnessSelectionFailure[]} unavailable - Rejected harness candidates.
   * @returns {string} Human-readable reason for the failed selection.
   */
  function unavailableReason(unavailable) {
    if (!harnessFactories.size) return 'no harness registered';
    if (!unavailable.length) return 'no available harness';
    return `no available harness: ${unavailable.map((u) => `${u.id}: ${u.reason}`).join('; ')}`;
  }

  /**
   * `run(prompt, opts)` — spawn a session via the resolved harness. Returns a `Result`: with no
   * harness registered (or the named one absent) it is `fail(SUMO_NO_HARNESS)`; otherwise the harness
   * adapter builds the `Session` and it is returned as `ok({ value: session })`.
   *
   * @access public
   * @param {string} prompt - Prompt supplied to `run`.
   * @param {HarnessRunOptions} opts - Options read by this operation.
   * @returns {Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>} Promise that resolves with the shared Result returned by `run`.
   */
  async function run(prompt, opts = {}) {
    const { name, unavailable } = await selectHarness(opts);
    if (!name) {
      return fail('SUMO_NO_HARNESS', unavailableReason(unavailable));
    }
    // Fresh adapter per run(): built-in adapters hold mutable transport state (process, queues, args),
    // so reusing a single instance across multiple sessions corrupts subsequent spawns.
    const adapter = /** @type {Function} */ (harnessFactories.get(name))(buildCtx(name, 'harness'));
    if (typeof adapter.run !== 'function') {
      throw new SumoError({ name: 'plugin', method: 'run', code: 'SUMO_HARNESS_NO_RUN', message: `harness '${name}' adapter does not implement run(prompt, opts)` });
    }
    // Wrap adapter.run() so a thrown spawn error becomes a classified failed Result.
    // Without this, a thrown SumoError (e.g. from CodexAppServer.open() handshake failure) propagates
    // through wrapRun's catch block, triggering rollback correctly but losing the classified code.
    // Returning fail() lets the orchestrator read code/hints from the Result for failover decisions.
    let session;
    try {
      session = await adapter.run(prompt, opts);
    } catch (err) {
      // Classify using any evidence attached to the thrown error (or just the error message).
      const thrown = err && typeof err === 'object' ? /** @type {{ evidence?: Record<string, unknown>, cause?: unknown, code?: unknown, message?: unknown }} */ (err) : {};
      const evidence = thrown.evidence ?? {};
      const spawnError = evidence.spawnError instanceof Error ? evidence.spawnError : thrown.cause instanceof Error ? thrown.cause : null;
      const cls = classify({ ...evidence, spawnError });
      // Prefer the error's own code if it's already more specific than SUMO_SPAWN_FAILED.
      const code = (typeof thrown.code === 'string' && thrown.code !== 'SUMO_SPAWN_FAILED')
        ? thrown.code
        : cls.code;
      return fail(code, typeof thrown.message === 'string' ? thrown.message : cls.reason);
    }
    return ok(session);
  }

  /**
   * Instantiate every registered messenger and return `{ name, adapter }` so the runtime can drive
   * each adapter's `ingress()` and fan produced work onto the `on('work', …)` channel.
   *
   * @access public
   * @returns {Array<{ name: string, adapter: unknown }>} List produced by `instantiateMessengers`.
   */
  function instantiateMessengers() {
    return [...messengerFactories.entries()].map(([name, factory]) => ({
      name, adapter: factory(buildCtx(name, 'messenger'))
    }));
  }

  return {
    harness, messenger, run, instantiateMessengers, /**
     * Detect whether a harness provider is registered.
     *
     * @access public
     * @returns {boolean} Whether `hasHarness` matched the expected condition.
     */
    hasHarness() { return harnessFactories.size > 0; }, /**
     * Detect whether a messenger provider is registered.
     *
     * @access public
     * @returns {boolean} Whether `hasMessenger` matched the expected condition.
     */
    hasMessenger() { return messengerFactories.size > 0; }, /**
     * Check whether a harness factory is registered by name.
     *
     * @access public
     * @param {string} name - Name used by `hasHarnessName`.
     * @returns {boolean} Whether `hasHarnessName` matched the expected condition.
     */
    hasHarnessName(name) { return harnessFactories.has(name); }, /**
     * Check whether a messenger factory is registered by name.
     *
     * @access public
     * @param {string} name - Name used by `hasMessengerName`.
     * @returns {boolean} Whether `hasMessengerName` matched the expected condition.
     */
    hasMessengerName(name) { return messengerFactories.has(name); }, /**
     * Expose harness factories so capabilities can enumerate without bypassing the provider path.
     *
     * @access public
     * @returns {Map<string, Function>} Map<string function> returned by `harnessFactories`.
     */
    harnessFactories() { return harnessFactories; }, buildContext: buildCtx
  };
}
