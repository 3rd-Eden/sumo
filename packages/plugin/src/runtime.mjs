/**
 * The plugin runtime: wires the flat verb surface a plugin author touches to `sumo/config` (ordered
 * `use` list + validated options) and `sumo/db` (event log + scoped KV), builds the objects handed
 * INTO plugins, and runs the single-pass lifecycle (spec 03 "Lifecycle").
 *
 * Lifecycle ( — DB opens BEFORE activation so a plugin can call `store()` in its body):
 *   1. resolve config → ordered `use` list
 *   2. import plugin modules → parse each `.sumo` decl (config schema + declared deps), canonicalize id
 *   3. open the daemon connection
 *   4. activate via a dependency fixpoint (deps before dependents; missing/unavailable → skip; cycles
 *      broken + reported). Each plugin activates TRANSACTIONALLY — its registrations are staged and
 *      committed only if its function returns; a throw rolls them back.
 *   5. subscribe `on` handlers from the persisted watermark; ready
 * `destroy` callbacks run on shutdown in reverse, after intake is paused and in-flight work drained ().
 *
 * @module sumo/plugin/runtime
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'sumo/config';
import { open } from 'sumo/db';
import { adapters } from 'sumo/harness';
import { register as registerHarnessCapabilities } from 'sumo/harness/capabilities';
import { register as registerWorkCapabilities } from 'sumo/work';
import { register as registerSessionCapabilities } from 'sumo/session';
import { sleep } from 'sumo/util';
import { registry } from './engine.mjs';
import { providers } from './providers.mjs';
import { storage } from './store.mjs';
import { toEvent, toSteer, toContext, buildWork } from './received.mjs';
import { registration, load, dependencies, sort } from './use.mjs';
import { ok, fail, isResult, HandlerSchema, DeclSchema, RUNTIME_PLUGIN_ID } from './schema.mjs';
import { create, toJSON } from 'sumo/capability';
import { SumoError } from 'sumo/error';

/** Plugin ids beginning with this prefix are reserved for the runtime's own KV — rejected (P0). */
const RESERVED_PREFIX = '__sumo_';
/** The built-in `sumo` facade verbs; a privileged `extendFacade` verb may not collide with these. */
const BUILTIN_FACADE_VERBS = new Set(['use', 'on', 'before', 'command', 'skill', 'run', 'store', 'install', 'harness', 'messenger', 'destroy', 'emit']);
/** Soft high-water mark for the delivery queue; crossing it emits a one-time backpressure warning. */
const QUEUE_HIGH_WATER = 10_000;
/** Upper bound on how long `stop()` waits for ingress/in-flight work before forcing through. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Convert a validated Sumo duration string to milliseconds.
 *
 * @access private
 * @param {unknown} value - Config duration value.
 * @returns {number|undefined} Milliseconds when value is a valid duration.
 */
function durationMs(value) {
 if (typeof value !== 'string') return undefined;
 const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value);
 if (!match) return undefined;
 const unit = match[2];
 const scale = unit ? { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]: undefined;
 return scale === undefined ? undefined: Number(match[1]) * scale;
}

/**
 * @typedef {import('../../config/src/schema.mjs').ResolvedConfig} RuntimeConfig
 */

/**
 * @typedef {object} DbEvent
 * @property {number} seq - Monotonic event sequence.
 * @property {number} [ts] - Event timestamp.
 * @property {string} type - Event type.
 * @property {string} [sessionId] - Session id associated with the event.
 * @property {Record<string, unknown>} [payload] - Event payload.
 * @property {Record<string, unknown>} [ext] - Adapter-specific event extension data.
 * @property {string} [rawRef] - Raw record reference.
 */

/**
 * @typedef {{ fn: Function, schema?: import('zod').ZodType, plugin: string, capability: import('sumo/capability').CapabilityDef }} CommandEntry
 */

/**
 * @typedef {{ fn: Function, meta?: object, plugin: string }} SkillEntry
 */

/**
 * @typedef {{ plugin: string, spec: object, sourceBase?: string }} InstallIntent
 */

/**
 * @typedef {{ plugin: string, fn: Function }} DestroyEntry
 */

/**
 * @typedef {object} ActivationTx
 * @property {Function[]} applies - Staged registry mutations to apply on activation success.
 * @property {Map<string, CommandEntry>} commands - Staged command registrations.
 * @property {Map<string, SkillEntry>} skills - Staged skill registrations.
 * @property {InstallIntent[]} installs - Staged install intents.
 * @property {DestroyEntry[]} destroys - Staged destroy callbacks.
 * @property {import('./use.mjs').Registration[]} registers - Staged child plugin registrations.
 * @property {Set<string>} providerNames - Provider names registered during this activation.
 */

/**
 * @typedef {Record<string, unknown> & {
 * use: (arg: string|Function|{ name?: string, fn: Function }, opts?: Record<string, unknown>) => RuntimeFacade,
 * on: (event: string, fn: Function, opts?: Record<string, unknown>) => void,
 * before: (action: string, fn: Function, opts?: Record<string, unknown>) => void,
 * command: (nameOrCap: string|import('sumo/capability').CapabilityDef, fn?: Function, schema?: import('zod').ZodType) => void,
 * skill: ((name: string, fn: Function, meta?: object) => void) & { run: (name: string, context?: Record<string, unknown>) => Promise<import('./schema.mjs').Result> },
 * run: (prompt: string, opts?: import('./providers.mjs').HarnessRunOptions) => Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>,
 * store: (ns?: string) => import('./schema.mjs').Store,
 * install: (spec: Record<string, unknown>) => import('./schema.mjs').Result,
 * harness: (name: string, impl: Function) => void,
 * messenger: (name: string, impl: Function) => void,
 * destroy: (fn: Function) => void,
 * emit: (type: string, payload?: Record<string, unknown>, opts?: { dedupe?: string, sessionId?: string }) => Promise<unknown>
 * }} RuntimeFacade
 */

/**
 * @typedef {object} PluginRuntime
 * @property {RuntimeFacade} sumo - Root facade available before activation.
 * @property {() => Promise<PluginRuntime>} start - Start config resolution, activation, and event subscription.
 * @property {() => Promise<void>} stop - Stop ingress, destroy plugins, and close owned database handles.
 * @property {(action: string, spec?: { payload?: Record<string, unknown>, ext?: Record<string, unknown>, can?: import('sumo/session').CapabilitiesSchema, sessionId?: string }) => Promise<{ event: Record<string, unknown> } | { deny: string }>} steer - Run steering handlers.
 * @property {(name: string, args?: Record<string, unknown>, ctxOpts?: { surface?: 'cli'|'mcp'|'programmatic', print?: (text: string) => void, warn?: (d: object) => void, ask?: (prompt: string, opts?: object) => Promise<import('./schema.mjs').Result<string>> }) => Promise<import('./schema.mjs').Result>} invoke - Invoke a registered command.
 * @property {(verb: string, handler: Function, opts?: { staged?: boolean }) => void} extendFacade - Add a privileged facade verb before start.
 * @property {(hook: (prompt: string, opts: import('./providers.mjs').HarnessRunOptions|undefined, baseRun: ReturnType<typeof providers>['run'], pluginId: string) => Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>) => void} wrapRun - Wrap the provider spawn path before start.
 * @property {() => Promise<void>} drainIngress - Await finite messenger ingress tasks.
 * @property {() => import('./schema.mjs').Diagnostic[]} diagnostics - Return collected runtime diagnostics.
 * @property {() => number} watermark - Return the persisted event watermark.
 * @property {() => Array<import('zod').infer<typeof import('sumo/capability').EntrySchema>>} capabilities - Return the capability catalog.
 * @property {() => Array<{ id: string, providers: string[] }>} listHarnesses - Return registered harnesses and provider declarations.
 * @property {() => string[]} harnessFallback - Return configured harness fallback ids.
 * @property {(harnessId: string, output: string) => { category: string, reasoning: string, remedy?: string[] } | null} diagnoseFor - Run harness-specific dialog diagnosis.
 * @property {() => Map<string, CommandEntry>} commands - Return registered commands.
 * @property {() => Map<string, SkillEntry>} skills - Return registered skills.
 * @property {() => InstallIntent[]} installIntents - Return staged install intents.
 */

/**
 * Create a plugin runtime.
 *
 * @access public
 * @param {{ cwd?: string, flags?: object, env?: object, db?: import('sumo/db').SumoDb, config?: Partial<RuntimeConfig> }} opts - Runtime construction options.
 * @returns {PluginRuntime} Runtime facade and lifecycle controls.
 */
export function plugin({ cwd = process.cwd(), flags = {}, env = process.env, db: injectedDb, config: configOverride } = {}) {
  /** @type {import('./schema.mjs').Diagnostic[]} */
  const diagnostics = [];

  /**
   * Convert plugin failures into runtime diagnostics without aborting unrelated plugins.
   *
   * @access public
   * @param {unknown} err - Error value normalized or reported by `onError`.
   * @param {{ key?: string, severity?: import('./schema.mjs').Diagnostic['severity'] }} meta - Metadata associated with the operation.
   * @returns {void} Completes without producing a value.
   */
  function onError(err, meta = {}) {
    // A SumoError self-describes; anything else is wrapped with the plugin context. The serialized
    // form is a superset of the diagnostic shape (code/message/severity/source), so push it directly.
    const record = err && typeof err === 'object' ? /** @type {{ code?: unknown, message?: unknown }} */ (err) : {};
    const code = typeof record.code === 'string' ? record.code : 'SUMO_INTERNAL';
    const message = typeof record.message === 'string' ? record.message : String(err);
    const e =
      err instanceof SumoError
        ? err
        : SumoError.wrap(err, {
            name: 'plugin', method: meta.key ?? 'handler', code, message, severity: meta.severity ?? 'error', source: meta.key ? { plugin: meta.key } : {}
          });
    diagnostics.push(/** @type {import('./schema.mjs').Diagnostic} */ (e.toJSON()));
  }

  const engine = registry({ onError });
  /** @type {Map<string, CommandEntry>} */
  const commands = new Map();
  /** @type {Map<string, SkillEntry>} */
  const skills = new Map();
  /** @type {InstallIntent[]} */
  const installIntents = [];
  /** @type {DestroyEntry[]} activation order */
  const destroyFns = [];
  /** @type {import('./use.mjs').Registration[]} */
  const pending = [];
  const activated = new Set();
  const unavailable = new Set();

  let db = injectedDb;
  let ownsDb = !injectedDb;
  /** @type {ReturnType<typeof providers>} */
  let prov;
  /** @type {RuntimeConfig} */
  let config;
  /** @type {(() => void)|undefined} */
  let unsub;
  let started = false;
  let stopping = false;

  // ── privileged extension seams (the orchestrator consumes these; the runtime only forwards) ──────
  /** @type {Map<string, { handler: Function, staged: boolean }>} extra `sumo` facade verbs (modify/guard/surface/health) */
  const facadeExtensions = new Map();
  /** @type {((prompt: string, opts: import('./providers.mjs').HarnessRunOptions|undefined, baseRun: ReturnType<typeof providers>['run'], pluginId: string) => Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>)|undefined} spawn wrapper */
  let runHook;

  // ── per-plugin activation transaction (staged registrations, committed only on success) ──────────
  /** @type {ActivationTx|null} */
  let tx = null;

  // ── event delivery: own FIFO queue + contiguous-seq watermark () ───────────────────────────
  /** @type {DbEvent[]} */
  const queue = [];
  let queueHead = 0;
  let pumping = false;
  let watermark = 0;
  let backpressureWarned = false;
  /** @type {import('./schema.mjs').Store|undefined} */
  let wmStore;
  /** @type {Promise<unknown>[]} */
  const ingressTasks = [];
  /** @type {AsyncIterator<unknown>[]} */
  const ingressIterators = [];
  const ingressController = new AbortController();

  /**
   * Identify ids reserved for Sumo-owned runtime behavior.
   *
   * @access public
   * @param {string} id - Identifier used by `reserved`.
   * @returns {boolean} Whether `reserved` matched the expected condition.
   */
  function reserved(id) {
    return id.startsWith(RESERVED_PREFIX);
  }

  /**
   * Check all pending and active plugin namespaces before accepting a registration.
   *
   * @access public
   * @param {string} id - Identifier used by `idTaken`.
   * @returns {boolean} Whether `idTaken` matched the expected condition.
   */
  function idTaken(id) {
    return activated.has(id) || unavailable.has(id) || pending.some((p) => p.id === id) || (tx?.registers.some((r) => r.id === id) ?? false);
  }

  /**
   * Register a plugin (root-level `use`, or a pack's `use(child)` during activation → staged in `tx`).
   * Missing id, reserved id, and duplicate id are all programmer errors → throw (§3b, P0).
   *
   * @access public
   * @param {string|Function|{ name?: string, fn: Function }} arg - Plugin registration argument.
   * @param {unknown} options - Inline plugin options to merge with config.
   * @returns {void} Queues the plugin registration or throws for invalid ids.
   */
  function register(arg, options) {
    const reg = registration(arg, options);
    if (reserved(reg.id)) throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_RESERVED_PREFIX', message: `sumo.use: '${reg.id}' uses the reserved '${RESERVED_PREFIX}' prefix` });
    if (idTaken(reg.id)) throw new SumoError({ name: 'plugin', method: 'use', code: 'SUMO_DUPLICATE_REGISTRATION', message: `sumo.use: '${reg.id}' is already registered — select a unique name` });
    (tx ? tx.registers : pending).push(reg);
  }

  /**
   * Shallow-merge two option sources (config slice + inline `use(plugin, opts)`); inline wins.
   *
   * @access public
   * @param {unknown} configOpts - Config opts supplied to `mergeOpts`.
   * @param {unknown} inlineOpts - Inline opts supplied to `mergeOpts`.
   * @returns {unknown} Merged option value, preferring inline options.
   */
  function mergeOpts(configOpts, inlineOpts) {
    if (configOpts && typeof configOpts === 'object' && inlineOpts && typeof inlineOpts === 'object') {
      return { ...configOpts, ...inlineOpts };
    }
    return inlineOpts ?? configOpts ?? {};
  }

  /**
   * Resolve the `options` a plugin activates with: the `plugins.<id>` config slice merged with any
   * inline `use(plugin, opts)` (inline wins), then validated as a whole against the plugin's declared
   * `.sumo.config` schema (so inline opts cannot bypass validation — AR/Codex fix). A failed slice
   * marks the plugin unavailable with a diagnostic, never a crash.
   *
   * @access public
   * @param {import('./use.mjs').Registration} reg - Reg supplied to `resolveOptions`.
   * @returns {{ available: boolean, options?: Record<string, unknown> }} Structured output from `resolveOptions`.
   */
  function resolveOptions(reg) {
    const id = reg.id;
    const schema = /** @type {import('zod').ZodType|undefined} */ (reg.decl?.config);
    const merged = mergeOpts(config.plugins?.[id], reg.options);
    if (schema) {
      const parsed = schema.safeParse(merged);
      if (!parsed.success) {
        onError({ code: 'SUMO_PLUGIN_CONFIG_INVALID', message: `plugin "${id}" config is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}` }, { key: id }
        );
        return { available: false };
      }
      return { available: true, options: /** @type {Record<string, unknown>} */ (parsed.data) };
    }
    return { available: true, options: /** @type {Record<string, unknown>} */ (merged && typeof merged === 'object' ? merged : {}) };
  }

  /**
   * The per-plugin `sumo` facade (): identity is baked in so `store`/`emit`/`destroy`/etc. are
   * scoped to THIS plugin. During activation every registry mutation is **staged** into `tx` and the
   * facade gives immediate validation/dup feedback (the call throws), but the registry is only mutated
   * when the plugin's function returns successfully. The same facade backs root-level registration.
   *
   * @access public
   * @param {string} pluginId - Plugin identifier.
   * @param {string} sourceBase - Source base supplied to `makeSumo`.
   * @returns {RuntimeFacade} Plugin facade scoped to the given plugin id.
   */
  function makeSumo(pluginId, sourceBase = cwd) {
    /**
     * Stage registry mutation during activation transactions, otherwise apply it immediately.
     *
     * @access public
     * @param {Function} fn - Function to register or invoke.
     * @returns {unknown} Return value from `stage`.
     */
    function stage(fn) {
      if (tx) return tx.applies.push(fn);
      return fn();
    }

 /**
 * Register a skill owned by this facade's plugin.
 *
 * @access public
 * @param {string} name - Globally unique skill name.
 * @param {Function} fn - Skill callback invoked by `skill.run`.
 * @param {object} [meta] - Optional skill metadata and provisioning source.
 * @returns {void} Completes without producing a value.
 */
 function skill(name, fn, meta) {
 if (skills.has(name) || tx?.skills.has(name)) throw new SumoError({ name: 'plugin', method: 'skill', code: 'SUMO_DUPLICATE_REGISTRATION', message: `sumo.skill: '${name}' is already registered — select a unique name` });
 (tx ? tx.skills: skills).set(name, { fn, meta, plugin: pluginId });
 // Provisioning (so a harness surfaces it as a slash command) is the install layer's job (spec
 // 13, via `npx skills`). Record the intent only.
 const metadata = meta && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta): {};
 const source = typeof metadata.source === 'string' ? metadata.source: undefined;
 (tx ? tx.installs: installIntents).push({
 plugin: pluginId,
 spec: { skills: [{ name, ...(source ? { source }: {}) }] },
 sourceBase
 });
 }

 /**
 * Run a registered skill through its public runtime contract.
 *
 * @access public
 * @param {string} name - Registered skill name.
 * @param {Record<string, unknown>} [context] - Workflow context handed to the skill callback.
 * @returns {Promise<import('./schema.mjs').Result>} Skill result envelope.
 */
 skill.run = async function runSkill(name, context = {}) {
 const entry = skills.get(name);
 if (!entry) return fail('SUMO_NO_SKILL', `no skill registered with name '${name}'`);
 try {
 const value = await entry.fn(context);
 return isResult(value) ? value: ok(value);
 } catch (err) {
 const reason = err instanceof Error ? err.message: String(err);
 onError(err, { key: `skill:${name}` });
 return fail('SUMO_SKILL_FAILED', `skill '${name}' failed: ${reason}`);
 }
 };

 /** @type {RuntimeFacade} */
 const facade = {
 /**
 * Execute `use`.
 *
 * @access public
 * @param {string|Function|{ name?: string, fn: Function }} arg - Plugin registration argument.
 * @param {Record<string, unknown>} [opts] - Inline plugin options.
 * @returns {RuntimeFacade} The same facade for chaining.
 */
 use(arg, opts) {
 register(arg, opts);
 return facade;
 }, /**
 * Execute `on`.
 *
 * @access public
 * @param {string} event - Function to register or invoke.
 * @param {unknown} fn - Function to register or invoke.
 * @param {Record<string, unknown>} opts - Options read by this operation.
 * @returns {void} Completes without producing a value.
 */
 on(event, fn, opts) {
 const parsed = HandlerSchema.parse(opts ?? {}); // bad opts throw here (pre-commit) → tx rolled back
 // Tag the handler with its plugin id; the db-event producer (pump) uses it to build a
 // plugin-scoped, deep-cloned SumoEvent per observer, so emit carries the right identity.
 stage(() => engine.add('observe', event, fn, { ...parsed, plugin: pluginId }));
 }, /**
 * Execute `before`.
 *
 * @access public
 * @param {string} action - Function to register or invoke.
 * @param {unknown} fn - Function to register or invoke.
 * @param {Record<string, unknown>} opts - Options read by this operation.
 * @returns {void} Completes without producing a value.
 */
 before(action, fn, opts) {
 const parsed = HandlerSchema.parse(opts ?? {});
 stage(() => engine.add('steer', action, fn, parsed));
 }, /**
 * Register a capability. Two forms:
 * - rich: `command(create({ name, title, description, inputSchema?, …, exec }))`
 * - thin: `command(name, fn, schema?)` — sugar that builds a minimal capability (title = name,
 * empty description, all surfaces, `inputSchema = schema` which may be undefined → no
 * validation / pass-through). Behaviour is identical to the pre-capability `command`.
 * The `commands` Map keeps `fn`/`schema`/`plugin` (so existing readers are unchanged) plus the
 * full `capability` (so the catalog and the CLI/MCP generators can project from one definition).
 *
 * @access public
 * @param {string|import('sumo/capability').CapabilityDef} nameOrCap - Name or cap supplied to `command`.
 * @param {unknown} fn - Function to register or invoke.
 * @param {Record<string, unknown>} schema - Schema used for validation.
 * @returns {void} Completes without producing a value.
 */
 command(nameOrCap, fn, schema) {
 const cap =
 typeof nameOrCap === 'string'
 ? create({ name: nameOrCap, title: nameOrCap, description: '', inputSchema: schema, exec: /** @type {Function} */ (fn) })
: create(nameOrCap); // re-validate (idempotent for an already-defined capability)
 const name = cap.name;
 if (commands.has(name) || tx?.commands.has(name)) throw new SumoError({ name: 'plugin', method: 'command', code: 'SUMO_DUPLICATE_REGISTRATION', message: `sumo.command: '${name}' is already registered — select a unique name` });
 (tx ? tx.commands: commands).set(name, { fn: cap.exec, schema: cap.inputSchema, plugin: pluginId, capability: cap });
 }, skill, /**
 * Execute `run`.
 *
 * @access public
 * @param {string} prompt - Prompt to send to the selected harness.
 * @param {import('./providers.mjs').HarnessRunOptions} opts - Harness run options.
 * @returns {Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>} Spawn result from the runtime provider path.
 */
 run(prompt, opts) {
 // A privileged consumer (the orchestrator) may wrap spawn via `wrapRun` so EVERY `sumo.run`
 // is guard-checked + registered; unset, this is the bare provider spawn. `pluginId` lets the
 // hook default a guard scope to the calling plugin.
 return runHook ? runHook(prompt, opts, prov.run, pluginId): prov.run(prompt, opts);
 }, /**
 * Execute `store`.
 *
 * @access public
 * @param {string} ns - Ns supplied to `store`.
 * @returns {unknown} Return value from `store`.
 */
 store(ns) {
 return storage(/** @type {import('sumo/db').SumoDb} */ (db), pluginId, ns ?? 'main');
 }, /**
 * Execute `install`.
 *
 * @access public
 * @param {Record<string, unknown>} spec - Object fields used to build the normalized value.
 * @returns {unknown} Return value from `install`.
 */
 install(spec) {
 (tx ? tx.installs: installIntents).push({ plugin: pluginId, spec, sourceBase });
 return ok();
 }, /**
 * Execute `harness`.
 *
 * @access public
 * @param {string} name - Name used by `harness`.
 * @param {unknown} impl - Provider implementation to register.
 * @returns {void} Completes without producing a value.
 */
 harness(name, impl) {
 registerProvider('harness', name, impl, stage);
 }, /**
 * Execute `messenger`.
 *
 * @access public
 * @param {string} name - Name used by `messenger`.
 * @param {unknown} impl - Provider implementation to register.
 * @returns {void} Completes without producing a value.
 */
 messenger(name, impl) {
 registerProvider('messenger', name, impl, stage);
 }, /**
 * Execute `destroy`.
 *
 * @access public
 * @param {Function} fn - Function to register or invoke.
 * @returns {void} Completes without producing a value.
 */
 destroy(fn) {
 (tx ? tx.destroys: destroyFns).push({ plugin: pluginId, fn });
 }, /**
 * Emit a plugin-sourced event to the shared event log. Useful for emitting custom events
 * from outside an `on`/`before` handler (where `event.emit` isn't available). The
 * caller may supply a `dedupe` key for idempotency; a random UUID is used otherwise.
 *
 * @access public
 * @param {string} type - Event name or type handled by `emit`.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @param {{ dedupe?: string, sessionId?: string }} opts - Options read by this operation.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `emit`.
 */
 emit(type, payload = {}, opts = {}) {
 const dedupe = opts.dedupe ?? `plugin:${pluginId}:emit:${type}:${randomUUID()}`;
 return /** @type {import('sumo/db').SumoDb} */ (db).append({
 dedupe, type, source: 'plugin', payload,
 ...(opts.sessionId ? { sessionId: opts.sessionId }: {})
 });
 }
 };

    // Privileged facade-verb extensions (orchestrator). A `staged` verb (a registrar like
    // `modify`/`guard`) routes through `stage()` so it commits/rolls back with this plugin's
    // activation — parity with `on`/`before`. A non-staged verb (an action like `surface`/`health`)
    // is an immediate call. `pluginId` is bound so the handler can scope per-plugin.
    for (const [verb, ext] of facadeExtensions) {
      const extendedFacade = /** @type {Record<string, unknown>} */ (facade);
      if (ext.staged) {
        /**
         * Register one staged facade extension call for rollback-aware activation.
         *
         * @access private
         * @param {...unknown} args - Arguments supplied by the plugin facade verb.
         * @returns {unknown} Return value from the staged facade registrar.
         */
        extendedFacade[verb] = function stagedFacadeExtension(...args) {
          return stage(() => ext.handler(pluginId, ...args));
        };
      } else {
        /**
         * Invoke one immediate facade extension call.
         *
         * @access private
         * @param {...unknown} args - Arguments supplied by the plugin facade verb.
         * @returns {unknown} Return value from the privileged facade handler.
         */
        extendedFacade[verb] = function immediateFacadeExtension(...args) {
          return ext.handler(pluginId, ...args);
        };
      }
    }
    return facade;
  }

  /**
   * Stage a provider (harness/messenger) registration with a call-time duplicate check (so the plugin
   * gets immediate feedback and the actual `providers.*` call cannot dup-throw at commit time).
   *
   * @access public
   * @param {string} kind - Name used for lookup or registration.
   * @param {string} name - Name used for lookup or registration.
   * @param {Function} impl - Provider factory to stage.
   * @param {(fn: Function) => unknown} stage - Staging callback used during activation.
   * @returns {void} Stages a provider registration after duplicate checks.
   */
  function registerProvider(kind, name, impl, stage) {
    if (!prov) throw new SumoError({ name: 'plugin', method: 'provider', code: 'SUMO_PROVIDER_PHASE', message: `sumo.${kind} can only be called during plugin activation` });
    const taken = kind === 'harness' ? prov.hasHarnessName(name) : prov.hasMessengerName(name);
    if (taken || tx?.providerNames.has(`${kind}:${name}`)) throw new SumoError({ name: 'plugin', method: 'provider', code: 'SUMO_DUPLICATE_REGISTRATION', message: `sumo.${kind}: '${name}' is already registered — select a unique name` });
    tx?.providerNames.add(`${kind}:${name}`);
    stage(() => (kind === 'harness' ? prov.harness(name, impl) : prov.messenger(name, impl)));
  }

  /**
   * Resolve the originating session for a delivered event.
   *
   * @access public
   * @returns {Promise<undefined>} Promise resolving to the `resolveSession` result.
   */
  async function resolveSession() {
    return undefined;
  }

  /**
   * Activate one plugin transactionally: stage its registrations, await its (possibly async) function,
   * then commit on success or discard on throw so a failed plugin leaves nothing registered (AR/Codex).
   *
   * @access public
   * @param {import('./use.mjs').Registration} reg - Reg supplied to `activate`.
   * @param {unknown} options - Options read by this operation.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function activate(reg, options) {
    tx = { applies: [], commands: new Map(), skills: new Map(), installs: [], destroys: [], registers: [], providerNames: new Set() };
    const staged = tx;
    try {
      const sourceBase = reg.moduleHref ? path.dirname(fileURLToPath(reg.moduleHref)) : cwd;
      const activateFn = /** @type {Function} */ (reg.fn);
      await activateFn(makeSumo(reg.id, sourceBase), options); // await: async plugin bodies + late use(child) complete
    } catch (e) {
      tx = null;
      onError({ code: 'SUMO_PLUGIN_ACTIVATE', message: `plugin '${reg.id}' threw during activation: ${e?.message ?? e}` }, { key: reg.id });
      return; // staged registrations discarded
    }
    tx = null;
    for (const apply of staged.applies) apply();
    for (const [n, v] of staged.commands) commands.set(n, v);
    for (const [n, v] of staged.skills) skills.set(n, v);
    installIntents.push(...staged.installs);
    destroyFns.push(...staged.destroys);
    for (const r of staged.registers) pending.push(r);
  }

  /**
   * Import (string) plugins, parse each `.sumo` decl, and canonicalize a string plugin's id from its declared name.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function importAndPrepare() {
    for (const reg of pending) {
      if (reg.prepared || reg.failed) continue;
      if (reg.kind === 'module' && !reg.fn) {
        try {
          const { fn, decl, href } = await load(/** @type {string} */ (reg.moduleSpec), cwd);
          reg.fn = fn;
          reg.decl = decl;
          reg.moduleHref = href;
        } catch (e) {
          reg.failed = true;
          onError({ code: 'SUMO_PLUGIN_LOAD', message: `failed to load plugin '${reg.moduleSpec}': ${e?.message ?? e}` }, { key: reg.id });
          continue;
        }
      }
      // Validate the static marker once (P1: DeclSchema was defined but never parsed).
      if (reg.decl !== undefined) {
        const parsed = DeclSchema.safeParse(reg.decl);
        if (!parsed.success) {
          reg.failed = true;
          onError({ code: 'SUMO_PLUGIN_DECL_INVALID', message: `plugin '${reg.id}' has an invalid .sumo declaration: ${parsed.error.issues.map((i) => i.message).join('; ')}` }, { key: reg.id }
          );
          continue;
        }
        reg.decl = parsed.data;
        // Canonicalize a string-loaded plugin's id from its declared name (P1) so config keys/schemas
        // resolve correctly; re-run the reserved + duplicate checks against the canonical id.
        if (reg.kind === 'module' && reg.decl.name && reg.decl.name !== reg.id) {
          const canon = reg.decl.name;
          if (reserved(canon) || activated.has(canon) || unavailable.has(canon) || pending.some((p) => p !== reg && p.id === canon)) {
            reg.failed = true;
            onError({ code: 'SUMO_PLUGIN_DECL_INVALID', message: `plugin '${reg.id}' declares an unusable/duplicate/reserved name '${canon}'` }, { key: reg.id });
            continue;
          }
          reg.id = canon;
        }
      }
      reg.prepared = true;
    }
  }

  /**
   * Activate all pending plugins as a dependency fixpoint: in each round, activate every plugin whose
   * declared deps are already active; defer the rest. When a round makes no progress, classify the
   * deferred set — genuinely missing/unavailable deps become `SUMO_PLUGIN_DEP_MISSING` + skip; an
   * otherwise-deadlocked set is a cycle, broken by activating in topo order with `SUMO_PLUGIN_CYCLE`.
   * Handles late pack registrations (re-imported each round) and programmatic unavailability.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function activatePending() {
    for (;;) {
      await importAndPrepare();
      const remaining = pending.filter((p) => !(/** @type {Record<string, unknown>} */ (p).failed) && !activated.has(p.id) && !unavailable.has(p.id));
      if (!remaining.length) return;

      const knownIds = new Set(pending.filter((p) => !(/** @type {Record<string, unknown>} */ (p).failed)).map((p) => p.id));
      const regById = new Map(pending.map((p) => [p.id, p]));
      const { order } = sort(remaining.map((p) => ({ id: p.id, deps: dependencies(p.decl) })));

      let progressed = false;
      const deferred = [];
      for (const id of order) {
        if (activated.has(id) || unavailable.has(id)) continue;
        const reg = regById.get(id);
        if (!reg) continue;
        const opt = resolveOptions(reg);
        if (!opt.available) {
          unavailable.add(id); // diagnostic already recorded by resolveOptions
          progressed = true;
          continue;
        }
        const unmet = dependencies(reg.decl).filter((d) => !activated.has(d));
        if (unmet.length) {
          deferred.push(id);
          continue; // wait for deps to activate first (preserves ordering)
        }
        activated.add(id);
        await activate(reg, opt.options);
        progressed = true;
      }
      if (progressed) continue; // re-evaluate: deferred may now be satisfiable, packs may have registered

      // Deadlock. Classify the deferred set.
      let resolvedAny = false;
      for (const id of deferred) {
        if (activated.has(id) || unavailable.has(id)) continue;
        const reg = regById.get(id);
        if (!reg) continue;
        const missing = dependencies(reg.decl).filter((d) => !knownIds.has(d) || unavailable.has(d));
        if (missing.length) {
          unavailable.add(id);
          onError({ code: 'SUMO_PLUGIN_DEP_MISSING', message: `plugin '${id}' requires missing/unavailable plugin(s): ${missing.join(', ')}` }, { key: id });
          resolvedAny = true;
        }
      }
      if (resolvedAny) continue; // marking some unavailable can cascade — re-evaluate

      // The remaining deferred form a dependency cycle (deps known + available, none activated). Break
      // it by activating in topo order (the back-edge was already dropped by sort).
      let brokeAny = false;
      for (const id of order) {
        if (activated.has(id) || unavailable.has(id)) continue;
        const reg = regById.get(id);
        if (!reg) continue;
        onError({ code: 'SUMO_PLUGIN_CYCLE', message: `plugin '${id}' is part of a dependency cycle (activated in best-effort order)` }, { key: id });
        activated.add(id);
        await activate(reg, resolveOptions(reg).options);
        brokeAny = true;
      }
      if (!brokeAny) return; // nothing left we can do
      // loop once more so any packs the cycle members registered get picked up
    }
  }

  /**
   * Drain the delivery queue sequentially (FIFO): await each event's fan-out to completion, then
   * advance + best-effort-persist the contiguous watermark (). `engine.fanout` isolates observer
   * errors and never throws; a watermark-persist failure is surfaced and tolerated (at-least-once on
   * restart). Never rejects.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queueHead < queue.length && !stopping) {
        const event = queue[queueHead++];
        // Build a fresh, deep-cloned, plugin-scoped SumoEvent per observer (correct emit identity).
        await engine.fanout(event.type, event, (rec, plugin) => toEvent(
          /** @type {import('./received.mjs').EventRecord} */ (rec),
          {
            db: /** @type {import('./received.mjs').EventDb} */ (/** @type {unknown} */ (db)),
            plugin: typeof plugin === 'string' ? plugin : RUNTIME_PLUGIN_ID,
            resolveSession
          }
        ));
        watermark = event.seq;
        try {
          await wmStore?.set('watermark', watermark);
        } catch (e) {
          onError(e, { key: RUNTIME_PLUGIN_ID, severity: 'warning' });
        }
      }
    } finally {
      if (queueHead > 0) {
        queue.splice(0, queueHead);
        queueHead = 0;
      }
      pumping = false;
      if (queue.length && !stopping) void pump().catch((e) => onError(e, { key: RUNTIME_PLUGIN_ID }));
    }
  }

  /**
   * Drive each registered messenger's `ingress()`, fanning produced work onto the `on('work')` channel.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  function startIngress() {
    for (const { adapter } of prov.instantiateMessengers()) {
      const messenger = /** @type {{ ingress?: () => AsyncIterator<import('./schema.mjs').Work> }} */ (adapter);
      if (typeof messenger.ingress !== 'function') continue;
      const it = messenger.ingress();
      ingressIterators.push(it);
      ingressTasks.push((async () => {
          try {
            for (let r = await it.next(); !r.done; r = await it.next()) {
              if (stopping) break;
              // Decorate each work item with `emit` (bound to db + the consuming plugin) so an
              // `on('work', …)` handler can append derived events — parity with `toEvent`.
              await engine.fanout(
                'work',
                /** @type {Record<string, unknown>} */ (r.value),
                (w, plugin) => buildWork(
                  /** @type {import('./schema.mjs').Work} */ (w),
                  {
                    db: /** @type {Pick<import('./received.mjs').EventDb, 'append'>} */ (/** @type {unknown} */ (db)),
                    plugin: typeof plugin === 'string' ? plugin : RUNTIME_PLUGIN_ID
                  }
                )
              );
            }
          } catch (e) {
            onError(e, { key: 'ingress' });
          }
        })());
    }
  }

  /** @type {PluginRuntime} */
  const runtime = {
    /** The root `sumo` facade plugin authors register against before `start()`. */
    sumo: makeSumo('root', cwd), /**
     * Resolve config, activate plugins, connect + subscribe. Idempotent.
     *
     * @access public
     * @returns {Promise<unknown>} Promise resolving to the `start` result.
     */
    async start() {
      if (started) return runtime;
      started = true;

      const r0 = resolve({
        cwd,
        flags: /** @type {Record<string, unknown> & { config?: string }} */ (flags),
        env: /** @type {NodeJS.ProcessEnv} */ (env)
      });
      config = r0.config;
      if (configOverride) Object.assign(config, configOverride);
      diagnostics.push(...r0.diagnostics);

      // seed activation from config.use (strings), preserving order, skipping ones already queued
      for (const entry of config.use) {
        if (!pending.some((p) => p.id === entry)) pending.push({ id: entry, kind: 'module', moduleSpec: entry });
      }

 // open the daemon connection BEFORE activation so store works in a plugin body
 if (!db) {
 db = await open({
 ...(typeof config.storage?.path === 'string' ? { dbPath: config.storage.path }: {}),
 ...(typeof config.daemon?.socket === 'string' ? { socket: config.daemon.socket }: {}),
 ...(durationMs(config.daemon?.idleShutdown) !== undefined ? { idleShutdownMs: /** @type {number} */ (durationMs(config.daemon?.idleShutdown)) }: {})
 });
 ownsDb = true;
 }
 prov = providers({
 /**
 * Allocate storage under the runtime-owned adapter namespace.
 *
 * @access public
 * @param {string} name - Name used by `adapterStore`.
 * @returns {import('./schema.mjs').Store} Import(' /schema mjs') store returned by `adapterStore`.
 */
 adapterStore(name) { return storage(/** @type {import('sumo/db').SumoDb} */ (db), name, 'main'); }, /**
 * Resolve either full runtime config or a plugin-specific config slice.
 *
 * @access public
 * @param {string} name - Name used by `configFor`.
 * @returns {Record<string, unknown>} Structured output from `configFor`.
 */
 configFor(name) {
 if (!name) return /** @type {Record<string, unknown>} */ (config);
 const slice = config.plugins?.[name];
 return slice && typeof slice === 'object' ? /** @type {Record<string, unknown>} */ (slice): {};
 }, onError, signal: ingressController.signal, db // harness adapters append normalized events through the daemon client (sole writer)
 });

      // Auto-register built-in harness adapters (core capability, not user plugins).
      for (const [id, Cls] of Object.entries(adapters)) {
        prov.harness(id, (/** @type {unknown} */ hctx) => {
          const ctx = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (hctx));
          const harnessConfig = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (config.harness ?? {}));
          const adapterConfig = harnessConfig[id] && typeof harnessConfig[id] === 'object' ? /** @type {Record<string, unknown>} */ (harnessConfig[id]) : {};
          return new Cls({ ...ctx, config: adapterConfig });
        });
      }

      // Register harness-layer capabilities (harnesses, models) through the facade.
      // Pass the factory map + buildCtx so the capability enumerates through the provider path
      // (respects plugin-replaced factories) rather than constructing adapters directly.
      registerHarnessCapabilities(runtime.sumo, {
        factories: prov.harnessFactories(), /**
         * Build the adapter context through the provider path used by plugins.
         *
         * @access public
         * @param {string} id - Identifier used by `buildCtx`.
         * @param {'harness'|'messenger'} kind - Kind used by `buildCtx`.
         * @returns {Record<string, unknown>} Structured output from `buildCtx`.
         */
        buildCtx(/** @type {string} */ id, /** @type {'harness'|'messenger'} */ kind) { return prov.buildContext(id, kind); }
      });

 registerWorkCapabilities(runtime.sumo, {
 config: /** @type {Record<string, unknown>} */ (config),
 signal: ingressController.signal,
 db: /** @type {import('sumo/db').SumoDb} */ (db)
 });
 registerSessionCapabilities(runtime.sumo);

      await activatePending();

      // subscribe from the persisted watermark; ready
      wmStore = storage(db, RUNTIME_PLUGIN_ID, 'sub');
      {
        const storedWatermark = await wmStore.get('watermark');
        watermark = typeof storedWatermark === 'number' ? storedWatermark : 0;
      }
      unsub = await db.subscribe({ since: watermark }, (event) => {
        queue.push(/** @type {DbEvent} */ (event));
        if (queue.length - queueHead > QUEUE_HIGH_WATER && !backpressureWarned) {
          backpressureWarned = true;
          onError({ code: 'SUMO_QUEUE_BACKPRESSURE', message: `event delivery queue exceeded ${QUEUE_HIGH_WATER}; observers are slower than ingest` }, { key: RUNTIME_PLUGIN_ID, severity: 'warning' }
          );
        }
        pump().catch((e) => onError(e, { key: RUNTIME_PLUGIN_ID }));
      });

      startIngress();
      return runtime;
    }, /**
     * Pause intake, abort + drain ingress (bounded), run destroy callbacks reverse, then close an owned db ().
     *
     * @access public
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async stop() {
      stopping = true;
      ingressController.abort();
      if (unsub) unsub();
      // signal cooperative ingress generators to finish, then wait — bounded so an uncooperative
      // generator cannot hang shutdown.
      for (const it of ingressIterators) {
        try {
          await it.return?.();
        } catch { /* ignore */ }
      }
      await Promise.race([Promise.allSettled(ingressTasks), sleep(SHUTDOWN_TIMEOUT_MS)]);
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (pumping && Date.now() < deadline) await sleep(5);

      for (let i = destroyFns.length - 1; i >= 0; i--) {
        try {
          await destroyFns[i].fn();
        } catch (e) {
          onError(e, { key: destroyFns[i].plugin });
        }
      }
      if (ownsDb && db) await db.close();
    }, /**
     * Drive the steering waterfall for an action (the harness/orchestrator layer calls this; tests too).
     *
     * @access public
     * @param {string} action - Action supplied to `steer`.
     * @param {{ payload?: Record<string, unknown>, ext?: Record<string, unknown>, can?: import('sumo/session').CapabilitiesSchema, sessionId?: string }} spec - Steering payload accepted by plugin policy handlers.
     * @returns {Promise<{ event: Record<string, unknown> } | { deny: string }>} Promise resolving to the `steer` result.
     */
    async steer(action, spec = {}) {
      return engine.steer(action, toSteer({ action, ...spec }));
    }, /**
     * Invoke a registered command programmatically (the CLI/MCP layer renders the surface; spec 09).
     *
     * @access public
     * @param {string} name - Name used by `invoke`.
     * @param {Record<string, unknown>} args - Argument object accepted by `invoke`.
     * @param {{ surface?: 'cli'|'mcp'|'programmatic', print?: (text: string) => void, warn?: (d: object) => void, ask?: (prompt: string, opts?: object) => Promise<import('./schema.mjs').Result<string>> }} ctxOpts - Ctx opts supplied to `invoke`.
     * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `invoke`.
     */
    async invoke(name, args = {}, ctxOpts = {}) {
      const cmd = commands.get(name);
      if (!cmd) return fail('SUMO_NO_COMMAND', `no command '${name}' registered`);
      const surface = ctxOpts.surface ?? 'programmatic';
      // Surface gating (defence-in-depth): the CLI/MCP generators already filter the catalog by
      // surface, so a capability never appears where it shouldn't. This guard catches a direct
      // `invoke(name, …, {surface})` for a surface the capability does not declare.
      if (!cmd.capability.surfaces.includes(surface)) {
        return fail('SUMO_SURFACE_UNSUPPORTED', `command '${name}' is not available on the '${surface}' surface`);
      }
      let parsed = args;
      if (cmd.schema) {
        const r = cmd.schema.safeParse(args);
        if (!r.success) return fail('SUMO_COMMAND_INPUT_INVALID', r.error.issues.map((i) => i.message).join('; '));
        parsed = r.data;
      }
      const ctx = toContext({ surface, cwd, print: ctxOpts.print, warn: ctxOpts.warn, ask: ctxOpts.ask });
      return ok(await cmd.fn(parsed, ctx));
    }, /**
     * Contribute an extra verb to every plugin's `sumo` facade (a privileged consumer — the
     * orchestrator — owns the vocabulary; the runtime only forwards). Must be called BEFORE `start()`
     * (per-plugin facades are built during activation). `handler(pluginId, ...args)` receives the
     * calling plugin's id. A `staged` verb is a registrar (rolls back with failed activation, like
     * `on`); a non-staged verb is an immediate action.
     *
     * @access public
     * @param {unknown} verb - Verb used by `extendFacade`.
     * @param {unknown} handler - Callback invoked by `extendFacade`.
     * @param {Record<string, unknown>} opts - Options read by this operation.
     * @returns {void} Completes without producing a value.
     */
    extendFacade(verb, handler, { staged = false } = {}) {
      if (started) throw new SumoError({ name: 'plugin', method: 'extendFacade', code: 'SUMO_FACADE_INVALID', message: 'runtime.extendFacade: must be called before start()' });
      if (BUILTIN_FACADE_VERBS.has(verb)) throw new SumoError({ name: 'plugin', method: 'extendFacade', code: 'SUMO_FACADE_INVALID', message: `runtime.extendFacade: '${verb}' collides with a built-in facade verb` });
      if (facadeExtensions.has(verb)) throw new SumoError({ name: 'plugin', method: 'extendFacade', code: 'SUMO_DUPLICATE_REGISTRATION', message: `runtime.extendFacade: '${verb}' is already registered` });
      if (typeof handler !== 'function') throw new SumoError({ name: 'plugin', method: 'extendFacade', code: 'SUMO_FACADE_INVALID', message: 'runtime.extendFacade: handler must be a function' });
      facadeExtensions.set(verb, { handler, staged });
    }, /**
     * Wrap the built-in `sumo.run` spawn (a privileged consumer — the orchestrator — guards every
     * spawn). Must be called BEFORE `start()`. `hook(prompt, opts, baseRun, pluginId)` decides whether
     * and how to spawn; `baseRun` is the bare provider spawn it delegates to.
     *
     * @access public
     * @param {(prompt: string, opts: import('./providers.mjs').HarnessRunOptions|undefined, baseRun: ReturnType<typeof providers>['run'], pluginId: string) => Promise<import('./schema.mjs').Result<import('./schema.mjs').Session>>} hook - Spawn wrapper that delegates to the provider path.
     * @returns {void} Completes without producing a value.
     */
    wrapRun(hook) {
      if (started) throw new SumoError({ name: 'plugin', method: 'wrapRun', code: 'SUMO_WRAPRUN_INVALID', message: 'runtime.wrapRun: must be called before start()' });
      if (runHook) throw new SumoError({ name: 'plugin', method: 'wrapRun', code: 'SUMO_DUPLICATE_REGISTRATION', message: 'runtime.wrapRun: a run hook is already registered' });
      if (typeof hook !== 'function') throw new SumoError({ name: 'plugin', method: 'wrapRun', code: 'SUMO_WRAPRUN_INVALID', message: 'runtime.wrapRun: hook must be a function' });
      runHook = hook;
    }, /**
     * Await all finite messenger ingress tasks.
     *
     * @access public
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async drainIngress() {
      await Promise.allSettled(ingressTasks);
    }, /**
     * Execute `diagnostics`.
     *
     * @access public
     * @returns {import('./schema.mjs').Diagnostic[]} List produced by `diagnostics`.
     */
    diagnostics() { return diagnostics.slice(); }, /**
     * Execute `watermark`.
     *
     * @access public
     * @returns {number} Numeric output from `watermark`.
     */
    watermark() { return watermark; }, /**
     * The machine-readable capability catalog — the SINGLE SOURCE OF TRUTH the CLI/MCP generators
     * (and the future journey-codifier) read. Each entry is the serializable projection of one
     * registered capability (input/output schemas as JSON Schema), tagged with its owning plugin.
     *
     * @access public
     * @returns {Array<import('zod').infer<typeof import('sumo/capability').EntrySchema>>} List produced by `capabilities`.
     */
    capabilities() { return [...commands.values()].map((c) => toJSON(c.capability, { plugin: c.plugin })); }, /**
     * List all registered harness adapters with their declared `can.providers`.
     * Used by the orchestrator's failover routing to pick a provider-compatible fallback.
     *
     * @access public
     * @returns {Array<{ id: string, providers: string[] }>} List produced by `listHarnesses`.
     */
    listHarnesses() {
      const factories = prov.harnessFactories();
      return [...factories.keys()].map((id) => {
        try {
          const factory = factories.get(id);
          if (!factory) return { id, providers: [] };
          const adapter = /** @type {{ can?: { providers?: string[] } }} */ (factory(prov.buildContext(id, 'harness')));
          return { id, providers: adapter.can?.providers ?? [] };
        } catch {
          return { id, providers: [] };
        }
      });
    }, /**
     * Return the resolved configured harness fallback order.
     * The copy prevents orchestrator callers from mutating runtime config state.
     *
     * @access public
     * @returns {string[]} List produced by `harnessFallback`.
     */
    harnessFallback() { return Array.isArray(config?.harness?.fallback) ? config.harness.fallback.slice() : []; }, /**
     * Run harness-specific dialog detection on captured pane output.
     * Delegates to the adapter class's static `diagnose(output)` method (declare-don't-fake:
     * returns null for harnesses with no known dialogs, e.g. Cursor).
     *
     * @access public
     * @param {string} harnessId - Harness id supplied to `diagnoseFor`.
     * @param {string} output - Output supplied to `diagnoseFor`.
     * @returns {{ category: string, reasoning: string, remedy?: string[] } | null} Structured output from `diagnoseFor`.
     */
    diagnoseFor(harnessId, output) {
      const factories = prov.harnessFactories();
      const factory = factories.get(harnessId);
      if (!factory) return null;
      try {
        const adapter = factory(prov.buildContext(harnessId, 'harness'));
        const diagnoseFn = adapter.constructor?.diagnose;
        return typeof diagnoseFn === 'function' ? diagnoseFn(output) : null;
      } catch {
        return null;
      }
    }, /**
     * Execute `commands`.
     *
     * @access public
     * @returns {Map<string, { fn: Function, schema?: import('zod').ZodType, plugin: string, capability: import('sumo/capability').CapabilityDef }>} Structured output from `commands`.
     */
    commands() { return commands; }, /**
     * Execute `skills`.
     *
     * @access public
     * @returns {Map<string, { fn: Function, meta?: object, plugin: string }>} Structured output from `skills`.
     */
    skills() { return skills; }, /**
     * Return the staged plugin install intents.
     *
     * @access public
     * @returns {Array<{ plugin: string, spec: object }>} List produced by `installIntents`.
     */
    installIntents() { return installIntents.slice(); }
  };

  return runtime;
}
