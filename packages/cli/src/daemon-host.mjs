/**
 * The steering daemon composition (spec 12, ): the SAME process runs the storage daemon AND the
 * project-scoped plugin runtimes. The storage daemon (`sumo/db`) stays harness/runtime-agnostic — this
 * layer wires its generic `onSteer` boundary to a `createSteerHost`, and gives each project runtime the
 * daemon's IN-PROCESS db facade (no socket hop, no `conns` idle interference).
 *
 * Lifecycle invariant: per-project idle eviction (default 5 min) winds down warm runtimes well before
 * the daemon's storage idle-shutdown (default 30 min), so storage never closes under a live runtime.
 *
 * @module sumo/cli/daemon-host
 */

import fs from 'node:fs';
import path from 'node:path';

import { start } from 'sumo/db/daemon';
import { watcher, adapters } from 'sumo/agent-artifacts';
import { createSteerHost } from './steer-host.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof start>>} DaemonHandle
 * @typedef {import('sumo/agent-artifacts').Artifacts} ArtifactAcquirer
 * @typedef {new () => ArtifactAcquirer} ArtifactConstructor
 * @typedef {{ stop: () => Promise<void>, ready?: Promise<void> }} IngestWatcher
 * @typedef {{ start: (db: import('sumo/db').SumoDb) => void, stop: () => Promise<void> }} IngestService
 * @typedef {{ home?: string, dbPath?: string, socket?: string, idleShutdownMs?: number, sweepIntervalMs?: number, readyBudgetMs?: number, projectIdleMs?: number, ingest?: boolean, env?: NodeJS.ProcessEnv, onClose?: (reason: string) => void }} SteeringDaemonOptions
 */

/**
 * Project scope for transcript ingestion: a cwd is in scope when its tree contains a project `sumo.yml`
 * (an explicit Sumo-managed project), walking up to the git root or filesystem root. This is the guard
 * that keeps always-on tailing from becoming whole-machine ingestion — a transcript in an unrelated
 * directory (no project sumo.yml) is ignored. The GLOBAL `~/.sumo/sumo.yml` is not a project marker.
 *
 * @access private
 * @param {string|undefined} cwd - Filesystem location used by `isSumoProject`.
 * @returns {boolean} Whether `isSumoProject` matched the expected condition.
 */
function isSumoProject(cwd) {
  if (!cwd) return false;
  let dir;
  try { dir = path.resolve(cwd); } catch { return false; }
  for (;;) {
    if (fs.existsSync(path.join(dir, 'sumo.yml'))) return true;
    if (fs.existsSync(path.join(dir, '.git'))) return false; // git root without a sumo.yml → not managed
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Build the daemon-resident transcript-ingestion service (default ON, project-scoped). Adapts the
 * agent-artifacts service to the daemon's `{ start(db), stop() }` lifecycle boundary.
 *
 * @access private
 * @returns {IngestService} Daemon-owned worker that starts and stops transcript ingestion.
 */
function makeIngestService() {
  /** @type {IngestWatcher|undefined} */
  let svc;
  const instances = Object.values(adapters)
    .map((Cls) => new (/** @type {ArtifactConstructor} */ (Cls))())
    .filter((a) => a.can?.tail);
  return {
    /**
     * Start the co-hosted transcript watcher against the daemon client.
     *
     * @access public
     * @param {import('sumo/db').SumoDb} db - Database client used by the operation.
     * @returns {void} The watcher is retained for daemon shutdown.
     */
    start(db) { svc = watcher({ db, adapters: instances, isInScope: isSumoProject }); },
    /**
     * Stop the transcript watcher if it was started.
     *
     * @access public
     * @returns {Promise<void>} Resolves after the watcher drains its shutdown work.
     */
    stop() { return svc?.stop?.() ?? Promise.resolve(); }
  };
}

/**
 * Start a storage daemon with steering co-hosted.
 * `ingest` (default true) co-hosts the always-on, project-scoped transcript ingestion service so a
 * session Sumo did not stream directly (a user-launched or natively-resumed `claude`/`codex`/`cursor`)
 * still lands its conversation in the DB. Pass `ingest: false` to disable.
 *
 * @access public
 * @param {SteeringDaemonOptions} opts - Storage, steering-host, ingestion, and lifecycle options.
 * @returns {Promise<{ daemon: DaemonHandle, host: ReturnType<typeof createSteerHost>, close: () => Promise<void> }>} Running daemon composition and close helper.
 */
export async function startSteeringDaemon(opts = {}) {
  /** @type {DaemonHandle|undefined} */
  let daemon;
  // Late-bound: inProcessClient() is only invoked on first steer (project creation), long after
  // start has resolved — so referencing `daemon` lazily here is safe.
  const host = createSteerHost({
    /**
     * Lazily expose the daemon client after daemon startup has completed.
     *
     * @access public
     * @returns {import('sumo/db').SumoDb} In-process daemon client for hosted project runtimes.
     */
    inProcessClient() {
      if (!daemon) throw new Error('steering daemon client requested before daemon startup completed');
      return daemon.inProcessClient();
    }, env: opts.env,
    ...(opts.readyBudgetMs !== undefined ? { readyBudgetMs: opts.readyBudgetMs } : {}),
    ...(opts.projectIdleMs !== undefined ? { projectIdleMs: opts.projectIdleMs } : {})
  });

  // Default ON (project-scoped); `ingest:false` or `SUMO_INGEST=0` disables (test isolation / opt-out).
  const ingestEnabled = opts.ingest !== false && (opts.env ?? process.env).SUMO_INGEST !== '0';
  const service = ingestEnabled ? makeIngestService() : undefined;

 daemon = await start({
 ...(opts.home !== undefined ? { home: opts.home }: {}),
 ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath }: {}),
 ...(opts.socket !== undefined ? { socket: opts.socket }: {}),
 ...(opts.idleShutdownMs !== undefined ? { idleShutdownMs: opts.idleShutdownMs }: {}),
 ...(opts.sweepIntervalMs !== undefined ? { sweepIntervalMs: opts.sweepIntervalMs }: {}), onSteer: host.onSteer, onSession: host.onSession,
 ...(service ? { service }: {})
 });

  // The daemon's onClose is single-slot; own it here and dispose the steering host before forwarding.
  daemon.onClose((reason) => {
    host.dispose().catch(() => {});
    opts.onClose?.(reason);
  });

  return {
    daemon, host,
    /**
     * Close steering first so no new project work enters while the daemon shuts down.
     *
     * @access public
     * @returns {Promise<void>} Resolves after hosted runtimes and storage daemon close.
     */
    async close() {
      await host.dispose();
      await daemon.close();
    }
  };
}
