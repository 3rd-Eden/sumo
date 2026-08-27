/**
 * @module sumo/cli
 *
 * The `sumo` CLI — a thin window onto the already-built layers. Each handler calls a public API of
 * `sumo/db` / `sumo/plugin` / `sumo/config` and renders the result through the shared renderers; the
 * CLI holds no workflow policy (CONVENTIONS §3c — surface, don't act).
 *
 * Handlers take an injectable context (`{ db, runtime, out, ... }`) so tests drive them against a
 * real daemon/runtime. `main(argv)` owns flag parsing and the open/start → dispatch → stop/close
 * lifecycle.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { Command } from 'commander';

import { open, key, SumoError } from 'sumo/db';
import { plugin, fail } from 'sumo/plugin';
import { resolve } from 'sumo/config';
import { forward as hooksForward, observe as hooksObserve } from 'sumo/hooks';
import { adapters } from 'sumo/harness';
import { sleep } from 'sumo/util';
import { VERSION } from '../../../src/version.mjs';

import { renderResult, renderDiagnostics, renderTable } from './render.mjs';
import { buildCapabilityCommand, capabilityRows, reservedCliCollisions } from './capabilities.mjs';
import { HOOK_INSTALLERS, installProject, projectDrift } from './install.mjs';

/**
 * @typedef {{ code: string, message: string, severity?: 'error'|'warning', source?: object }} CliDiagnostic
 */

/**
 * @typedef {Record<string, unknown> & { id?: string, harness?: string, state?: string, cwd?: string, updatedAt?: number, harnessSessionId?: string }} SessionRow
 */

/**
 * @typedef {Record<string, unknown> & { seq: number, ts?: number, type: string, sessionId?: string, source?: string }} EventRow
 */

/**
 * @typedef {{ id: string, status?: string, version?: string, providers?: string[] }} HarnessHealthRow
 */

/**
 * @typedef {{ plugin: string, spec: Record<string, unknown>, sourceBase?: string }} InstallIntent
 */

/**
 * @typedef {{ harness: string, cwd: string, action: string, payload?: Record<string, unknown>, ext?: Record<string, unknown>, nativeSessionId?: string }} HookSteerRequest
 */

/**
 * @typedef {{ ok: true, changed?: boolean, path?: string, warnings?: string[] } | { ok: false, code: string, reason: string }} HookInstallResult
 */

/**
 * @typedef {{ ok: true, changed?: boolean, path?: string } | { ok: false, code: string, reason: string }} HookUninstallResult
 */

/**
 * @typedef {{ install: (opts: { projectDir: string }) => HookInstallResult, uninstall: (opts: { projectDir: string }) => HookUninstallResult }} HookInstaller
 */

/**
 * @typedef {{
 *   hookEvents: Record<string, { kind: 'observe'|'decide', action?: string }>,
 *   toNativeRequest: (nativeEvent: string, payload: Record<string, unknown>) => {
 *     action: string,
 *     payload: Record<string, unknown>,
 *     ext: Record<string, unknown> & { nativeSessionId?: string }
 *   },
 *   toNativeResponse: (decision: Record<string, unknown>, nativeEvent: string, payload: Record<string, unknown>) => {
 *     stdout: string,
 *     exitCode: number,
 *     diagnostics: Array<{ code?: string, message: string }>
 *   },
 *   toObservation: (nativeEvent: string, payload: Record<string, unknown>) => {
 *     type: string,
 *     payload: Record<string, unknown>,
 *     ext: Record<string, unknown>,
 *     sessionId?: string,
 *     id?: string
 *   }|undefined
 * }} HookAdapter
 */

/**
 * Minimal daemon client surface used by hook forwarding and observation persistence.
 *
 * @access private
 * @typedef {{ put: (key: string, value: unknown) => Promise<void>, append: (event: Record<string, unknown>) => Promise<void>, steer: (request: Omit<{ id: string, op: 'steer', harness: string, cwd: string, action: string, payload: Record<string, unknown>, ext?: Record<string, unknown>, nativeSessionId?: string }, 'id'|'op'>) => Promise<unknown> }} HookDb
 */

/**
 * Hook steering callback signature used by the shared hook forwarder.
 *
 * @access private
 * @typedef {(request: {
 *   harness: string,
 *   cwd: string,
 *   action: string,
 *   payload: Record<string, unknown>,
 *   ext: Record<string, unknown>,
 *   nativeSessionId?: string
 * }) => Promise<Record<string, unknown>>} SteerFunction
 */

/**
 * Hook observation callback signature used by the shared hook forwarder.
 *
 * @access private
 * @typedef {(input: { adapter: HookAdapter, nativeEvent: string, payload: Record<string, unknown> }) => Promise<void>} ObserveFunction
 */

/**
 * @typedef {{ bin?: string }} ParsedHarnessConfig
 */

/**
 * @typedef {{ config?: { parse?: (cfg: Record<string, unknown>) => ParsedHarnessConfig }, interactiveResumeArgv?: (nativeId: string) => string[]|undefined }} AttachHarness
 */

/**
 * @typedef {new (ctx: { config: Record<string, unknown> }) => AttachHarness} AttachHarnessClass
 */

/**
 * Write one CLI output line.
 *
 * @access private
 * @param {string} line - Line supplied to `stdoutLine`.
 * @returns {boolean} Whether `stdoutLine` matched the expected condition.
 */
function stdoutLine(line) {
  return process.stdout.write(`${line}\n`);
}

/** The `evt:` keyspace prefix. `sumo/db` exports `key` but no event-key builder (surface-and-wait). */
const EVT_PREFIX = 'evt:';

/** Built-in verbs reserved by the CLI; any other first token is a plugin command name. */
export const BUILTINS = new Set(['list', 'events', 'tail', 'attach', 'commands', 'daemon', 'doctor', 'forward', 'install', 'uninstall', 'mcp', 'help']);

/**
 * Drain a `scan(prefix)` async-iterable of `[key, value]` into an array of values.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `scanValues` to read or write Sumo state.
 * @param {string} prefix - Key prefix to drain from the daemon scan iterator.
 * @returns {Promise<Array<Record<string, unknown>>>} Values returned by the matching key range.
 */
async function scanValues(db, prefix) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for await (const [, value] of db.scan(prefix)) out.push(/** @type {Record<string, unknown>} */ (value));
  return out;
}

/**
 * Parse an optional `--since <seq>` flag into a non-negative integer.
 *
 * @access private
 * @param {string|number|null|undefined} raw - User supplied sequence watermark.
 * @returns {{ ok: true, value?: number } | { ok: false, code: string, reason: string }} Structured output from `parseSince`.
 */
function parseSince(raw) {
  if (raw == null) return { ok: true };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return fail('SUMO_INVALID_ARGUMENT', `--since must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return { ok: true, value: n };
}

/**
 * `sumo list` — list session documents (`ses:` docs).
 *
 * @access public
 * @param {{ json?: boolean }} opts - Options read by this operation.
 * @param {{ db: import('sumo/db').SumoDb, out?: (line: string) => unknown }} ctx - Database and output context for the command.
 * @returns {Promise<number>} Process-style status code.
 */
export async function list(opts, ctx) {
  const { db, out = stdoutLine } = ctx;
  const rows = /** @type {SessionRow[]} */ (await scanValues(db, key('')));
  renderTable(rows, [
      { key: 'id', header: 'ID' }, { key: 'harness', header: 'HARNESS' }, { key: 'state', header: 'STATE' }, { key: 'cwd', header: 'CWD' }, { key: 'updatedAt', header: 'UPDATED' }
    ], { json: opts.json, out }
  );
  return 0;
}

/**
 * `sumo events` — query the event log (`evt:` scan + client-side filter).
 *
 * @access public
 * @param {{ json?: boolean, session?: string, type?: string, since?: string|number }} opts - Event filtering and rendering options.
 * @param {{ db: import('sumo/db').SumoDb, out?: (line: string) => unknown }} ctx - Database and output context for the command.
 * @returns {Promise<number>} Process-style status code.
 */
export async function events(opts, ctx) {
  const { db, out = stdoutLine } = ctx;
  const since = parseSince(opts.since);
  if (!since.ok) {
    renderResult(since, { json: opts.json, out });
    return 1;
  }
  let rows = /** @type {EventRow[]} */ (await scanValues(db, EVT_PREFIX));
  if (opts.session) rows = rows.filter((e) => e.sessionId === opts.session);
  if (opts.type) rows = rows.filter((e) => e.type === opts.type);
  // `since` is a watermark: events strictly after it (matches the daemon's exclusive `gt:` semantics).
  if (since.value != null) {
    const sinceSeq = since.value;
    rows = rows.filter((e) => e.seq > sinceSeq);
  }
  renderTable(rows, [
      { key: 'seq', header: 'SEQ' }, { key: 'ts', header: 'TS' }, { key: 'type', header: 'TYPE' }, { key: 'sessionId', header: 'SESSION' }, { key: 'source', header: 'SOURCE' }
    ], { json: opts.json, out }
  );
  return 0;
}

/**
 * `sumo tail` — live-follow the event stream via `subscribe`. Resolves when `signal` aborts
 * (Ctrl-C). Defaults to live-only: it subscribes from the current head seq so it does not dump the
 * whole backlog (which would also delay the first live event and Ctrl-C). `--since <seq>` overrides
 * the start watermark (use `--since 0` to replay the full log). `type` is array-wrapped for the
 * `subscribe` filter; `sessionId` is a scalar (matches `EventFilter`).
 *
 * @access public
 * @param {{ json?: boolean, session?: string, type?: string, since?: number|string }} opts - Options read by this operation.
 * @param {{ db: import('sumo/db').SumoDb, signal: AbortSignal, out?: (line: string) => unknown }} ctx - Database, abort signal, and output context for the command.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `tail`.
 */
export async function tail(opts, ctx) {
  const { db, signal, out = stdoutLine } = ctx;
  const since = parseSince(opts.since);
  if (!since.ok) {
    renderResult(since, { json: opts.json, out });
    return 1;
  }

  const filter = {};
  if (opts.type) filter.type = [opts.type];
  if (opts.session) filter.sessionId = opts.session;

  // Default start watermark = current head seq (live-only). An explicit --since wins.
  let from = since.value;
  if (from == null) {
    from = 0;
    for await (const [, event] of db.scan(EVT_PREFIX, { reverse: true, limit: 1 })) {
      from = /** @type {EventRow} */ (event).seq;
    }
  }

  const unsubscribe = await db.subscribe({ since: from, filter }, (event) => {
    const row = /** @type {EventRow} */ (event);
    if (opts.json) out(JSON.stringify(row));
    else out(`${row.seq}\t${row.type}\t${row.sessionId ?? ''}\t${row.source ?? ''}`);
  });

  try {
    await new Promise((resolve) => {
      if (signal.aborted) return resolve(undefined);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
  } finally {
    unsubscribe();
  }
  return 0;
}

/**
 * `sumo attach <sessionId>` — hand the user's real terminal to the harness's OWN native interactive
 * resume (`claude --resume`, `codex resume`, `cursor-agent --resume`), rather than re-implementing a
 * stream-back. Sumo's always-on transcript ingestion (Phase 3) + installed hooks keep the DB populated
 * during the native session, so observability is not lost. Resolves the harness/native-id/cwd from the
 * `ses:` doc and the bin from config.
 *
 * @access public
 * @param {{ sessionId?: string, json?: boolean }} opts - Options read by this operation.
 * @param {{ db: import('sumo/db').SumoDb, cwd?: string, env?: NodeJS.ProcessEnv, out?: (line: string) => unknown }} ctx - Database, process, and output context for attach.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `attach`.
 */
export async function attach({ sessionId, json }, ctx) {
  const { db, cwd = process.cwd(), env = process.env, out = stdoutLine } = ctx;
  if (!sessionId) { renderResult(fail('SUMO_INVALID_ARGUMENT', 'attach requires a session id'), { json, out }); return 1; }
  const rawDoc = await db.get(key(sessionId));
  if (!rawDoc) { renderResult(fail('SUMO_SESSION_UNKNOWN', `no session ${sessionId} in the registry`), { json, out }); return 1; }
  const doc = /** @type {SessionRow} */ (rawDoc);
  if (typeof doc.harness !== 'string') { renderResult(fail('SUMO_CONFIG_INVALID', `attach: session ${sessionId} has no harness id`), { json, out }); return 1; }
  const HarnessClass = /** @type {Record<string, AttachHarnessClass>} */ (/** @type {unknown} */ (adapters))[doc.harness];
  if (!HarnessClass) { renderResult(fail('SUMO_CAP_UNSUPPORTED', `attach: unknown harness '${doc.harness}'`), { json, out }); return 1; }
  const nativeId = doc.harnessSessionId;
  if (!nativeId) { renderResult(fail('SUMO_CAP_UNSUPPORTED', `attach: session ${sessionId} has no recorded native id to resume`), { json, out }); return 1; }

  const runCwd = doc.cwd ?? cwd;
  const { config } = resolve({ cwd: runCwd, env });
  const harnesses = /** @type {Record<string, Record<string, unknown>|undefined>} */ (config.harness ?? {});
  const harnessCfg = harnesses[doc.harness] ?? {};
  const adapter = new HarnessClass({ config: harnessCfg });
  const argv = adapter.interactiveResumeArgv?.(nativeId);
  if (!argv) { renderResult(fail('SUMO_CAP_UNSUPPORTED', `attach: ${doc.harness} has no native interactive resume`), { json, out }); return 1; }

  // Resolve the bin via the adapter's own config default (no duplicated default map).
  let bin = typeof harnessCfg.bin === 'string' ? harnessCfg.bin : undefined;
  try { bin = adapter.config?.parse?.(harnessCfg)?.bin ?? bin; } catch { /* raw/un-parseable cfg → keep harnessCfg.bin */ }
  if (!bin) { renderResult(fail('SUMO_CONFIG_INVALID', `attach: no bin configured for ${doc.harness}`), { json, out }); return 1; }

  // Hand off the real TTY (stdio: inherit) to the native resume; resolve with its exit code.
  const child = spawn(bin, argv, { stdio: 'inherit', cwd: runCwd });
  return await new Promise((resolve) => {
    child.on('error', (e) => { renderResult(fail('SUMO_SPAWN_FAILED', `attach: failed to launch ${bin}: ${e.message}`), { json, out }); resolve(1); });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * `sumo commands` — list commands registered by active plugins, plus any plugin diagnostics
 * (a plugin that failed to activate shows as an unavailable-with-reason diagnostic, never silently
 * absent). The runtime must be started by the caller (`main` / the test).
 *
 * @access public
 * @param {{ json?: boolean }} opts - Options read by this operation.
 * @param {{ runtime: ReturnType<typeof plugin>, out?: (line: string) => unknown }} ctx - Runtime and output context for the command.
 * @returns {Promise<number>} Process-style status code.
 */
export async function commands(opts, ctx) {
  const { runtime, out = stdoutLine } = ctx;
  // Generated from the capability catalog (the single source of truth), not hand-listed. Reachable
  // CLI capabilities only — a name that collides with a built-in verb is unreachable via the CLI, so
  // it is excluded from the listing and surfaced as a diagnostic instead of silently advertised.
  const rows = capabilityRows(runtime, BUILTINS);
  const shadowed = reservedCliCollisions(runtime, BUILTINS);
  const runtimeDiags = /** @type {CliDiagnostic[]} */ (runtime.diagnostics());
  /** @type {CliDiagnostic[]} */
  const diags = [
    ...runtimeDiags,
    ...shadowed.map((name) => ({
      code: 'SUMO_CLI_NAME_SHADOWED', message: `capability '${name}' collides with a built-in CLI verb and is not reachable via the CLI (still available on its other surfaces)`, severity: /** @type {'warning'} */ ('warning')
    }))
  ];

  if (opts.json) {
    out(JSON.stringify({ commands: rows, diagnostics: diags }));
    return 0;
  }
  renderTable(rows, [
      { key: 'command', header: 'COMMAND' }, { key: 'title', header: 'TITLE' }, { key: 'plugin', header: 'PLUGIN' }, { key: 'surfaces', header: 'SURFACES' }, { key: 'hasSchema', header: 'SCHEMA' }
    ], { out }
  );
  if (diags.length) {
    out('');
    renderDiagnostics(diags, { out });
  }
  return 0;
}

/**
 * `sumo <command> [--k v]` — invoke a registered plugin command generically (the share-one-runtime
 * payoff: a plugin command surfaced on the CLI with no per-command CLI code). The runtime wraps the
 * handler return in `ok(...)`; `renderResult` unwraps one level. `print`/`warn` are captured so
 * `--json` stdout stays clean.
 *
 * @access public
 * @param {string} name - Name used by `invoke`.
 * @param {Record<string, unknown>} args - Parsed CLI arguments passed to the plugin command.
 * @param {{ json?: boolean }} opts - CLI rendering options for the command invocation.
 * @param {{ runtime: Pick<ReturnType<typeof plugin>, 'invoke'>, out?: (line: string) => unknown }} ctx - Runtime and output context for the invocation.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `invoke`.
 */
export async function invoke(name, args, opts, ctx) {
  const { runtime, out = stdoutLine } = ctx;
  /** @type {string[]} */
  const prints = [];
  /** @type {Array<{ code: string, message: string, severity?: 'error'|'warning', source?: object }>} */
  const warnings = [];
  const result = await runtime.invoke(name, args, {
    surface: 'cli',
    /**
     * Buffer command prints when JSON mode must keep stdout machine-readable.
     *
     * @access public
     * @param {string} text - Text emitted by the plugin command.
     * @returns {unknown} The array length in JSON mode, otherwise the stream write result.
     */
    print(text) { return (opts.json ? prints.push(text) : out(text)); },
    /**
     * Collect command warnings so rendering can choose the surface-specific shape.
     *
     * @access public
     * @param {object} d - Diagnostic emitted by the plugin command.
     * @returns {number} The number of collected diagnostics.
     */
    warn(d) { return warnings.push(/** @type {CliDiagnostic} */ (d)); }
  });

  if (opts.json) {
    // Buffer everything into one envelope so a command that printed can't corrupt JSON stdout.
    let r = /** @type {import('sumo/error').Result<unknown>} */ (result);
    const nested = r.ok === true && r.value && typeof r.value === 'object'
      ? /** @type {import('sumo/error').Result<unknown>} */ (r.value)
      : undefined;
    if (nested && typeof nested.ok === 'boolean') {
      r = nested;
    }
    out(JSON.stringify({ result: r, prints, warnings }));
    return r.ok === true ? 0 : 1;
  }

  if (warnings.length) renderDiagnostics(warnings, { out });
  const ok = renderResult(result, { out });
  return ok ? 0 : 1;
}

/**
 * `sumo daemon status|stop` — reflect daemon lifecycle. `status` probes via `open({autostart:false})`
 * (up = connectable; down = throws `SUMO_NO_DAEMON`). `stop` is not buildable: `sumo/db` exposes no
 * public stop/shutdown control (surface-and-wait).
 *
 * @access public
 * @param {string} sub - Sub used by `daemon`.
 * @param {{ json?: boolean }} opts - CLI output options for daemon status rendering.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, out?: (line: string) => unknown }} ctx - Environment and output context for daemon status.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `daemon`.
 */
export async function daemon(sub, opts, ctx = {}) {
  const { home, env = process.env, out = stdoutLine } = ctx;
  const sumoHome = home ?? env.SUMO_HOME;

  if (sub === 'start') {
    const db = await open({ ...(sumoHome ? { home: sumoHome } : {}) });
    await db.close();
    return renderResult({ ok: true, value: { daemon: 'started', ...(sumoHome ? { home: sumoHome } : {}) } }, { json: opts.json, out }) ? 0 : 1;
  }

  if (sub === 'stop') {
    let db;
    try {
      db = await open({ ...(sumoHome ? { home: sumoHome } : {}), autostart: false });
    } catch (err) {
      if (err instanceof SumoError && err.code === 'SUMO_NO_DAEMON') {
        renderResult({ ok: false, code: 'SUMO_NO_DAEMON', reason: 'no sumo daemon is running' }, { json: opts.json, out });
        return 1;
      }
      throw err;
    }
    try {
      await db.shutdown();
    } finally {
      await db.close().catch(() => {});
    }
    const down = await waitDaemonDown({ home: sumoHome });
    return renderResult(down
      ? { ok: true, value: { daemon: 'stopped', ...(sumoHome ? { home: sumoHome } : {}) } }
      : { ok: false, code: 'SUMO_VERIFY_FAILED', reason: 'daemon acknowledged shutdown but was still reachable after the timeout' }, { json: opts.json, out }) ? 0 : 1;
  }

  if (sub === 'restart') {
    if (await daemonReachable({ home: sumoHome })) {
      const db = await open({ ...(sumoHome ? { home: sumoHome } : {}), autostart: false });
      try {
        await db.shutdown();
      } finally {
        await db.close().catch(() => {});
      }
      const down = await waitDaemonDown({ home: sumoHome });
      if (!down) {
        renderResult({ ok: false, code: 'SUMO_VERIFY_FAILED', reason: 'daemon acknowledged shutdown but was still reachable after the timeout' }, { json: opts.json, out });
        return 1;
      }
    }
    const db = await open({ ...(sumoHome ? { home: sumoHome } : {}) });
    await db.close();
    return renderResult({ ok: true, value: { daemon: 'restarted', ...(sumoHome ? { home: sumoHome } : {}) } }, { json: opts.json, out }) ? 0 : 1;
  }

  if (sub !== 'status') {
    renderResult({ ok: false, code: 'SUMO_INVALID_ARGUMENT', reason: `unknown daemon action '${sub}'` }, { json: opts.json, out });
    return 1;
  }

  const up = await daemonReachable({ home: sumoHome });
  const status = { up, ...(sumoHome ? { home: sumoHome } : {}) };
  if (opts.json) {
    out(JSON.stringify(status));
  } else {
    out(`daemon: ${up ? 'up' : 'down'}${sumoHome ? `  (SUMO_HOME=${sumoHome})` : ''}`);
  }
  return up ? 0 : 1;
}

/**
 * `sumo doctor` — the honest health view: config diagnostics + the runtime's schema-validated plugin
 * diagnostics (availability is judged by the runtime, not by `resolve` alone, which leaves
 * plugins unvalidated when no schemas are supplied) + daemon reachability. Takes pre-collected
 * `runtimeDiags` rather than a live runtime so it can still report health when the runtime could not
 * start (e.g. daemon down) — that failure is folded into the diagnostics by the caller.
 *
 * @access public
 * @param {{ json?: boolean }} opts - Options read by this operation.
 * @param {{ runtimeDiags?: CliDiagnostic[], harnessRows?: HarnessHealthRow[], installIntents?: InstallIntent[], cwd?: string, flags?: Record<string, unknown>, env?: NodeJS.ProcessEnv, home?: string, out?: (line: string) => unknown }} ctx - Diagnostics, config, and output context for doctor.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `doctor`.
 */
export async function doctor(opts, ctx) {
  const { runtimeDiags = [], harnessRows = [], installIntents = [], cwd = process.cwd(), flags = {}, env = process.env, home, out = stdoutLine } = ctx;
  const cfg = resolve({ cwd, flags, env });
  const configDiags = /** @type {CliDiagnostic[]} */ (cfg.diagnostics);
  const driftDiags = /** @type {CliDiagnostic[]} */ (projectDrift({ projectDir: cwd, flags, env, installIntents }));
  const diagnostics = [...configDiags, ...runtimeDiags, ...driftDiags];

  let daemonUp = true;
  try {
    const db = await open({ ...(home ? { home } : {}), autostart: false });
    await db.close();
  } catch (err) {
    if (err instanceof SumoError && err.code === 'SUMO_NO_DAEMON') daemonUp = false;
    else throw err;
  }

  const plugins = Object.entries(cfg.plugins).map(([name, r]) => ({
    plugin: name, available: r.available,
    ...(r.reason ? { reason: r.reason } : {})
  }));

  const unhealthy = !daemonUp || diagnostics.some((d) => (d.severity ?? 'error') === 'error');

  if (opts.json) {
    out(JSON.stringify({ daemon: { up: daemonUp }, harnesses: harnessRows, plugins, diagnostics }));
    return unhealthy ? 1 : 0;
  }

  out(`daemon: ${daemonUp ? 'up' : 'down'}`);
  out('');
  out('harnesses:');
  if (harnessRows.length) {
    renderTable(harnessRows.map((h) => ({ harness: h.id, status: h.status, version: h.version ?? '-', providers: (h.providers ?? []).join(', ') || '-' })), [
        { key: 'harness', header: 'HARNESS' }, { key: 'status', header: 'STATUS' }, { key: 'version', header: 'VERSION' }, { key: 'providers', header: 'PROVIDERS' }
      ], { out }
    );
  } else {
    out('  (none registered)');
  }
  out('');
  out('plugins:');
  if (plugins.length) {
    renderTable(plugins, [
        { key: 'plugin', header: 'PLUGIN' }, { key: 'available', header: 'AVAILABLE' }, { key: 'reason', header: 'REASON' }
      ], { out }
    );
  } else {
    out('  (none configured)');
  }
  out('');
  out('diagnostics:');
  renderDiagnostics(diagnostics, { out });
  return unhealthy ? 1 : 0;
}


/**
 * Read all of stdin to a UTF-8 string (the native hook payload). Empty for a TTY (no piped input).
 *
 * @access private
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stream - Input stream that may contain a hook payload.
 * @returns {Promise<string>} Complete UTF-8 payload read from stdin, or an empty string for a TTY.
 */
async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Probe whether a daemon is reachable without starting one.
 *
 * @access private
 * @param {{ home?: string }} opts - Daemon home options.
 * @returns {Promise<boolean>} Whether a daemon accepted a connection.
 */
async function daemonReachable({ home } = {}) {
  try {
    const db = await open({ ...(home ? { home } : {}), autostart: false });
    await db.close();
    return true;
  } catch (err) {
    if (err instanceof SumoError && err.code === 'SUMO_NO_DAEMON') return false;
    const code = /** @type {{ code?: string }} */ (err)?.code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return false;
    throw err;
  }
}

/**
 * Wait until the daemon no longer accepts connections.
 *
 * @access private
 * @param {{ home?: string, timeoutMs?: number }} opts - Daemon home and timeout options.
 * @returns {Promise<boolean>} Whether the daemon went down before the timeout.
 */
async function waitDaemonDown({ home, timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await daemonReachable({ home })) && (!home || !fs.existsSync(path.join(home, 'sumo.pid')))) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Append a hook diagnostic to the event log, bounded so a slow/stuck append can't blow the hook budget.
 *
 * @access private
 * @param {import('sumo/db').SumoDb|null|undefined} db - Optional daemon client used to append the diagnostic event.
 * @param {CliDiagnostic} diag - Hook diagnostic to persist.
 * @param {{ timeoutMs?: number }} opts - Append timeout budget in milliseconds.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
async function appendDiagBounded(db, diag, { timeoutMs = 500 } = {}) {
  if (!db) return;
  const append = db.append({
    dedupe: `hook:diag:${diag.code ?? 'SUMO_HOOK'}:${diag.message}`, type: 'hook.diagnostic', source: 'hook', payload: diag
  });
  await Promise.race([append.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/**
 * Normalize the CLI hook steer request to the daemon client's public `db.steer(...)` contract.
 *
 * @access private
 * @param {HookSteerRequest} request - Hook steering request assembled by the CLI forwarder.
 * @returns {Omit<{ id: string, op: 'steer', harness: string, cwd: string, action: string, payload: Record<string, unknown>, ext?: Record<string, unknown>, nativeSessionId?: string }, 'id'|'op'>} Daemon steer request payload.
 */
function toDbSteerRequest(request) {
  return {
    harness: request.harness,
    cwd: request.cwd,
    action: request.action,
    payload: request.payload ?? {},
    ...(request.ext ? { ext: request.ext } : {}),
    ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {})
  };
}

/**
 * `sumo forward <harness> <nativeEvent>` — the native hook entrypoint (spec 12, /). Thin and
 * logic-free: reads the native payload, asks the daemon-hosted runtime for a decision (`steer`), and
 * writes the harness's native response on stdout. ALL decision + translation lives elsewhere (the
 * daemon runtime and the harness adapter).
 * Diagnostics go to the EVENT LOG, never to stdout (stdout is the harness's native response channel).
 * When the daemon is unreachable, `forward` applies the per-hook fail-open/closed
 * policy from the install-encoded `safety` flag.
 *
 * @access public
 * @param {{ harness: string, nativeEvent: string, payloadText?: string, cwd?: string, safety?: boolean, steer?: SteerFunction, db?: import('sumo/db').SumoDb|null, out?: (s: string) => unknown, appendDiag?: (diag: CliDiagnostic) => Promise<unknown>|unknown }} opts - Native hook forwarding request.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `forward`.
 */
export async function forward({ harness, nativeEvent, payloadText, cwd = process.cwd(), safety = false, steer, db, out = (s) => process.stdout.write(s), appendDiag }) {
 /**
 * Drive hook steering through the daemon client when one is available.
 *
 * @access private
 * @param {HookSteerRequest} req - Normalized hook steering request.
 * @returns {Promise<Record<string, unknown>>} Steering decision returned by the daemon.
 */
 function steerViaDb(req) {
 return db
 ? /** @type {Promise<Record<string, unknown>>} */ (db.steer(toDbSteerRequest(req)))
: Promise.reject(new SumoError({ name: 'cli', method: 'forward', code: 'SUMO_NO_DAEMON', message: 'daemon is not available for hook steering' }));
 }

 const steerFn = steer ?? steerViaDb;
 // Observation hooks ingest onto the event stream (redact-before-append + dedupe collapse). Only when
 // a daemon is reachable; correlation to the Sumo session id is agent-artifacts' job (spec 09).
 /** @type {ObserveFunction|undefined} */
 let obs;
 if (db) {
 /**
 * Append one observed hook event through the daemon-backed hook observer.
 *
 * @access private
 * @param {{ adapter: HookAdapter, nativeEvent: string, payload: Record<string, unknown>, rawPayloadText?: string }} args - Normalized hook observation payload.
 * @returns {Promise<void>} Promise resolving after the hook observation is persisted.
 */
 obs = async function observeHook({ adapter, nativeEvent: ne, payload, rawPayloadText }) {
 await hooksObserve({
 adapter,
 harness,
 nativeEvent: ne,
 payload,
 rawPayloadText,
 db: /** @type {HookDb} */ (/** @type {unknown} */ (db))
 });
 };
 }
 const res = await hooksForward({ harness, nativeEvent, payloadText, cwd, safety, steer: steerFn, observe: obs });
 if (res.stdout) out(res.stdout); // ONLY the native response reaches stdout
 const emit = appendDiag ?? ((d) => appendDiagBounded(db, d));
 for (const d of res.diagnostics) await emit({ code: d.code ?? 'SUMO_HOOK', message: d.message });
 return res.exitCode;
}

/**
 * `sumo install [harness] [--dir <project>] [--yes]` — no harness reconciles project setup; an
 * explicit harness remains narrow hook-only repair.
 *
 * @access public
 * @param {{ harness?: string, projectDir?: string, yes?: boolean, flags?: object, env?: NodeJS.ProcessEnv, db?: import('sumo/db').SumoDb, out?: (s: string) => void }} args - Argument object accepted by `install`.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `install`.
 */
export async function install({ harness, projectDir = process.cwd(), yes = false, flags = {}, env = process.env, db, out = stdoutLine }) {
  if (!harness) return installProject({ projectDir, yes, flags, env, db, out });
  const installer = /** @type {HookInstaller|undefined} */ (/** @type {unknown} */ (HOOK_INSTALLERS[harness]));
  if (!installer) {
    renderResult({ ok: false, code: 'SUMO_UNSUPPORTED', reason: `hook install for '${harness}' is not supported (one of: ${Object.keys(HOOK_INSTALLERS).join(', ')})` }, { out });
    return 1;
  }
  if (!yes) {
    out(`would install Sumo ${harness} hooks under ${projectDir} (→ \`sumo forward ${harness} <event>\`); re-run with --yes to apply`);
    return 0;
  }
  const r = installer.install({ projectDir });
  if (!r.ok) {
    renderResult(r, { out });
    return 1;
  }
  out(`${r.changed ? 'installed' : 'already up to date'}: ${r.path}`);
  for (const w of r.warnings ?? []) out(`warning: ${w}`);
  return 0;
}

/**
 * `sumo uninstall [harness] [--dir <project>] [--yes]` — remove Sumo's hooks, preserving foreign config.
 *
 * @access public
 * @param {{ harness?: string, projectDir?: string, yes?: boolean, out?: (s: string) => void }} args - Argument object accepted by `uninstall`.
 * @returns {number} Numeric output from `uninstall`.
 */
export function uninstall({ harness = 'claude-code', projectDir = process.cwd(), yes = false, out = stdoutLine }) {
  const installer = /** @type {HookInstaller|undefined} */ (/** @type {unknown} */ (HOOK_INSTALLERS[harness]));
  if (!installer) {
    renderResult({ ok: false, code: 'SUMO_UNSUPPORTED', reason: `hook uninstall for '${harness}' is not supported (one of: ${Object.keys(HOOK_INSTALLERS).join(', ')})` }, { out });
    return 1;
  }
  if (!yes) {
    out(`would remove Sumo ${harness} hooks under ${projectDir} (foreign config preserved); re-run with --yes to apply`);
    return 0;
  }
  const r = installer.uninstall({ projectDir });
  if (!r.ok) {
    renderResult(r, { out });
    return 1;
  }
  out(`${r.changed ? 'removed Sumo hooks' : 'no Sumo hooks present'}: ${r.path}`);
  return 0;
}

/**
 * Extract a global value-flag (`--name v` / `--name=v`) from raw argv before commander parses.
 *
 * @access private
 * @param {string[]} argv - Raw command-line arguments to parse.
 * @param {string} name - Name used by `globalValue`.
 * @returns {string|undefined} Parsed flag value, when present.
 */
function globalValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

/**
 * The first non-option token = the subcommand (skipping the `--config <v>` value).
 *
 * @access private
 * @param {string[]} argv - Raw command-line arguments to parse.
 * @returns {string|undefined} First positional command token, when present.
 */
function firstSubcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--config') { i++; continue; }
    if (t.startsWith('-')) continue;
    return t;
  }
  return undefined;
}

/**
 * The `sumo` CLI entry. `commander` is the single front door: it owns global-flag parsing, per-command
 * flag parsing/coercion, `--help`, and usage errors. Built-in (infra) verbs are registered statically
 * and each action owns its own db/runtime lifecycle; **plugin capabilities are GENERATED** as commander
 * subcommands from `runtime.capabilities()` (spec 16). The runtime is booted LAZILY — only when the
 * invoked token is not an infra verb — so db-only verbs (`list`/`events`/`tail`) stay a bare `open`
 * with no plugin activation. Returns a process exit code without calling `process.exit`, so `cli.mjs`
 * and tests can map it.
 *
 * @access public
 * @param {string[]} argv - Raw command-line arguments to parse.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `main`.
 */
export async function main(argv) {
 let exitCode = 0;

 /**
 * Record the command exit code without terminating the process.
 *
 * @access public
 * @param {number | undefined} code - Code used in the generated output.
 * @returns {void} Completes without producing a value.
 */
 function setCode(code) {
 exitCode = code ?? 0;
 }

 // --config is read position-independently from raw argv so it applies whether it precedes or follows
 // the subcommand (it also feeds the lazy runtime construction below, which happens before parse).
 const flags = globalValue(argv, '--config') ? { config: globalValue(argv, '--config') }: {};

 /**
 * Attach global flags to a command so commander accepts them before or after the subcommand.
 *
 * @access public
 * @param {Command} command - Command supplied to `addGlobals`.
 * @returns {Command} Command returned by `addGlobals`.
 */
 function addGlobals(command) {
 return command
 .option('--json', 'machine-readable JSON output')
 .option('--config <path>', 'path to a config file');
 }

 /**
 * Read the effective `--json` flag after commander merges program and command options.
 *
 * @access public
 * @param {Command} command - Command supplied to `jsonOf`.
 * @returns {boolean} Whether `jsonOf` matched the expected condition.
 */
 function jsonOf(command) {
 return Boolean(command.optsWithGlobals().json);
 }

 const program = addGlobals(new Command('sumo'))
 .description('sumo — a window onto the running system')
 .version(VERSION)
 .exitOverride();
 program.configureOutput({
 /**
 * Delegate commander stdout to the process stream for testable output capture.
 *
 * @access public
 * @param {string} s - S supplied to `writeOut`.
 * @returns {boolean} Whether `writeOut` matched the expected condition.
 */
 writeOut(s) { return process.stdout.write(s); }, /**
 * Delegate commander stderr to the process stream for usage errors.
 *
 * @access public
 * @param {string} s - S supplied to `writeErr`.
 * @returns {boolean} Whether `writeErr` matched the expected condition.
 */
 writeErr(s) { return process.stderr.write(s); }
 });

 // ── infra verbs (each action owns its own lifecycle) ───────────────────────────────────────────
 addGlobals(program.command('list')).description('list sessions').action(async (o, cmd) => {
 const db = await open({});
 try { setCode(await list({ json: jsonOf(cmd) }, { db })); } finally { await db.close(); }
 });

 addGlobals(program.command('events')).description('query the event log')
 .option('--session <id>').option('--type <t>').option('--since <seq>')
 .action(async (o, cmd) => {
 const db = await open({});
 try { setCode(await events({ json: jsonOf(cmd), session: o.session, type: o.type, since: o.since }, { db })); }
 finally { await db.close(); }
 });

 addGlobals(program.command('tail')).description('live-follow the event stream (Ctrl-C to stop)')
 .option('--session <id>').option('--type <t>').option('--since <seq>')
 .action(async (o, cmd) => {
 const db = await open({});
 const controller = new AbortController();
 /**
 * Map Ctrl-C to the tail command's abort signal so cleanup remains in the action lifecycle.
 *
 * @access public
 * @returns {void} Completes without producing a value.
 */
 function onSig() {
 controller.abort();
 }
 process.once('SIGINT', onSig);
 try { setCode(await tail({ json: jsonOf(cmd), session: o.session, type: o.type, since: o.since }, { db, signal: controller.signal })); }
 finally { process.off('SIGINT', onSig); await db.close(); }
 });

 addGlobals(program.command('attach')).description('attach to a session via its harness\'s native interactive resume')
 .argument('<sessionId>', 'the Sumo session id (ses_...) to attach to')
 .action(async (sessionId, o, cmd) => {
 const db = await open({});
 try { setCode(await attach({ sessionId, json: jsonOf(cmd) }, { db })); }
 finally { await db.close(); }
 });

 addGlobals(program.command('daemon')).description('reflect daemon lifecycle').argument('[action]', 'status|start|stop|restart', 'status')
 .action(async (action, o, cmd) => { setCode(await daemon(action, { json: jsonOf(cmd) }, {})); });

 addGlobals(program.command('commands')).description('list registered plugin capabilities (+ diagnostics)')
 .action(async (o, cmd) => {
 const runtime = plugin({ flags });
 try { await runtime.start(); setCode(await commands({ json: jsonOf(cmd) }, { runtime })); }
 finally { await runtime.stop(); }
 });

 addGlobals(program.command('doctor')).description('config + plugin + daemon health').action(async (o, cmd) => {
 // Must report health even when the runtime can't start (daemon down) — start is best-effort.
 const runtime = plugin({ flags });
 /** @type {CliDiagnostic[]} */
 let runtimeDiags = [];
 let started = false;
 /** @type {HarnessHealthRow[]} */
 let harnessRows = [];
 /** @type {InstallIntent[]} */
 let installIntents = [];
 try {
 await runtime.start();
 started = true;
 runtimeDiags = /** @type {CliDiagnostic[]} */ (runtime.diagnostics());
 installIntents = /** @type {InstallIntent[]} */ (runtime.installIntents());
 // Probe all registered harnesses for availability. Use the `harnesses` capability if registered,
 // so plugin-replaced factories are respected.
 try {
 const r = await runtime.invoke('harnesses', {}, { surface: 'programmatic' });
 if (r?.ok && Array.isArray(r.value)) harnessRows = /** @type {HarnessHealthRow[]} */ (r.value);
 } catch { /* best-effort: harnesses capability may not be registered in all test setups */ }
 } catch (err) {
 const cause = /** @type {{ code?: string, message?: string }} */ (err);
 runtimeDiags = [/** @type {CliDiagnostic} */ (SumoError.wrap(err, { name: 'cli', method: 'doctor', code: cause?.code ?? 'SUMO_RUNTIME_STARTING', message: cause?.message ?? String(err) }).toJSON())];
 }
 try { setCode(await doctor({ json: jsonOf(cmd) }, { runtimeDiags, harnessRows, installIntents, flags })); }
 finally { if (started) await runtime.stop(); }
 });

 addGlobals(program.command('forward')).description('native hook entrypoint (payload on stdin)')
 .argument('<harness>').argument('<nativeEvent>').option('--safety')
 .action(async (harness, nativeEvent, o) => {
 const payloadText = await readStdin();
 /** @type {import('sumo/db').SumoDb|null} */
 let db = null;
 /** @type {SteerFunction} */
 let steer;
 try {
 db = await open({});
 /**
 * Forward a hook steering request through the opened daemon client.
 *
 * @access private
 * @param {HookSteerRequest} req - Normalized hook steering request.
 * @returns {Promise<Record<string, unknown>>} The daemon steering decision.
 */
 steer = (req) => /** @type {Promise<Record<string, unknown>>} */ (
 /** @type {import('sumo/db').SumoDb} */ (db).steer(toDbSteerRequest(req))
 );
 } catch (err) {
 /**
 * Reject steering while the daemon is unavailable so `forward` can apply the hook safety policy.
 *
 * @access private
 * @returns {Promise<Record<string, unknown>>} Promise rejected with the daemon open failure.
 */
 steer = () => /** @type {Promise<Record<string, unknown>>} */ (Promise.reject(err)); // no daemon → forward applies the fail-open/closed policy
 }
 const hookOpts = /** @type {{ safety?: boolean }} */ (o);
 try { setCode(await forward({ harness: String(harness), nativeEvent: String(nativeEvent), payloadText, safety: Boolean(hookOpts.safety), steer, db })); }
 finally { if (db) await db.close(); }
 });

 /** @type {Array<[string, (args: { harness?: string, projectDir: string, yes: boolean, flags?: Record<string, unknown> }) => number|Promise<number>]>} */
 const setupCommands = [['install', install], ['uninstall', uninstall]];
 for (const [verb, fn] of setupCommands) {
 addGlobals(program.command(verb)).description(`${verb} Sumo project setup or native hooks for one harness`)
 .argument('[harness]', 'harness id').option('--dir <project>').option('--yes')
 .action(async (harness, o) => {
 const opts = /** @type {{ dir?: string, yes?: boolean }} */ (o);
 const projectDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
 setCode(await fn({ harness: typeof harness === 'string' ? harness: undefined, projectDir, yes: Boolean(opts.yes), flags }));
 });
 }

 addGlobals(program.command('mcp')).description('serve registered capabilities to an MCP client (stdio)').action(async () => {
 const { serve } = await import('sumo/mcp');
 const serveMcp = /** @type {(runtime: unknown, opts?: { name?: string, version?: string, transport?: unknown }) => Promise<{ onclose?: () => void }>} */ (serve);
 const runtime = plugin({ flags });
 await runtime.start();
 try {
 const server = await serveMcp(runtime);
 // Stay alive until the client disconnects (transport close → server.onclose) or stdin closes;
 // either way the `finally` tears the runtime + db down. stdout is the MCP transport — keep it clean.
 await new Promise((resolve) => {
 /**
 * Resolve the MCP wait loop when either transport side closes.
 *
 * @access private
 * @returns {void} Completes without producing a value.
 */
 function done() {
 resolve(undefined);
 }
 server.onclose = done;
 process.stdin.once('close', done);
 });
 } finally { await runtime.stop(); }
 });

 // ── plugin capabilities: generated as commander subcommands from the catalog, but ONLY when the
 // invoked token is not an infra verb — so an infra/db-only command never boots the runtime. ──
 const sub = firstSubcommand(argv);
 const needsRuntime = sub && !BUILTINS.has(sub);
 /** @type {ReturnType<typeof plugin>|undefined} */
 let capRuntime;
 try {
 if (needsRuntime) {
 capRuntime = plugin({ flags });
 await capRuntime.start();
 const runtimeForCommand = capRuntime;
 for (const entry of runtimeForCommand.capabilities()) {
 if (!entry.surfaces.includes('cli') || BUILTINS.has(entry.name)) continue; // shadowed → unreachable
 const cmd = buildCapabilityCommand(entry, async (name, args, command) => {
 setCode(await invoke(name, args, { json: jsonOf(command) }, { runtime: runtimeForCommand }));
 });
 program.addCommand(addGlobals(cmd));
 }
 }
 await program.parseAsync(argv, { from: 'user' });
 } catch (err) {
 // exitOverride turns help/version/usage errors into CommanderError with an exitCode (help = 0,
 // usage error = 1); commander has already written the message. A real action error propagates.
 if (err && err.name === 'CommanderError') return err.exitCode ?? 1;
 throw err;
 } finally {
 if (capRuntime) await capRuntime.stop();
 }
 return exitCode;
}
