/**
 * Always-on transcript ingestion (the daemon-resident service half of spec 09).
 *
 * The harness live-stream source (`sumo/harness`) only captures sessions Sumo drives through its own
 * transport. A user-launched or natively-resumed session (e.g. `claude --resume`, `sumo attach`) writes
 * ONLY to its on-disk transcript — so without this, its conversation never reaches the DB (hooks carry
 * tool/permission events, not the assistant/reasoning turns). This service watches each tail-capable
 * acquirer's transcript root and auto-consumes new transcripts, correlating them to a `ses:` doc.
 *
 * Bounded by design:
 *  - SCOPED, not whole-machine: a transcript is ingested only when it correlates to an existing Sumo
 *    session OR its cwd is in a Sumo-managed project (`isInScope`). Unrelated projects are ignored.
 *  - NEW-content-only: `ignoreInitial` skips the pre-existing history on startup (no replay of the
 *    user's entire transcript archive); the per-file tail reads only bytes appended after discovery.
 *  - The directory watcher uses native events (cheap discovery); only the per-file `tail` polls,
 *    and only for files we are actively following — so watching a large tree is not a polling footgun.
 *  - Correlation/foreign-doc POLICY lives here, not in `correlate()` (a pure reader): ambiguity and
 *    no-signal SKIP (never mint a doc); a clearly-foreign in-scope transcript mints ONE passthrough
 *    `ses:` doc, guarded against the harness's own concurrent write by a native-id existence re-check.
 *
 * @module sumo/agent-artifacts/ingest-service
 */

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { watch } from 'chokidar';
import { id, key } from 'sumo/db';
import { withDefined } from 'sumo/util';

import { correlate } from './correlate.mjs';

const NEVER_ABORT = new AbortController().signal;

/**
 * @typedef {{ id: string, harness?: string, harnessSessionId?: string, observationSource?: string, state?: string, ext?: Record<string, unknown> } & Record<string, unknown>} SessionDoc
 * @typedef {import('./base/Artifacts.mjs').Artifacts} ArtifactAcquirer
 * @typedef {object} WatcherOptions
 * @property {import('sumo/db').SumoDb} db - Daemon database client used for correlation and persistence.
 * @property {ArtifactAcquirer[]} adapters - Tail-capable artifact acquirers to watch.
 * @property {(cwd: string) => boolean} [isInScope] - Project-scope predicate for foreign transcripts.
 * @property {(acquirer: ArtifactAcquirer) => string|undefined|null} [resolveRoot] - Transcript root resolver for each acquirer.
 * @property {boolean} [fromStart] - Whether chokidar should report existing transcript files on startup.
 * @property {number} [debounceMs] - Delay before correlating a newly discovered transcript.
 * @property {number} [idleEndMs] - Idle period after which a foreign observed session is marked ended.
 * @property {AbortSignal} [signal] - Shutdown signal passed to file tails.
 * @property {(line: string) => void} [log] - Diagnostic logger for ingestion decisions.
 */

/**
 * Read up to `maxLines` decoded JSON records from the head of a transcript (enough for `signals()`).
 * Uses bounded incremental reads so a large transcript does not have to be loaded just to correlate.
 *
 * @access public
 * @param {string} file - Path read or written by `readHead`.
 * @param {number} maxLines - Maximum number of JSON records to read.
 * @returns {Array<unknown>} Parsed transcript records from the file head.
 */
export function readHead(file, maxLines = 50) {
  /** @type {Array<unknown>} */
  const out = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      carry += decoder.write(buf.subarray(0, n));
      const lines = carry.split('\n');
      carry = /** @type {string} */ (lines.pop());
      for (const line of lines) {
        pushJsonLine(out, line, maxLines);
        if (out.length >= maxLines) return out;
      }
    }
    carry += decoder.end();
    if (carry.trim()) pushJsonLine(out, carry, maxLines);
  } catch {
    return out;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return out;
}

/**
 * Parse one transcript JSONL line and append it while respecting the caller's record budget.
 *
 * @access private
 * @param {Array<unknown>} out - Accumulator of parsed transcript records.
 * @param {string} line - Raw JSONL line.
 * @param {number} maxLines - Maximum number of records to keep.
 * @returns {void} Mutates `out` when the line parses and budget remains.
 */
function pushJsonLine(out, line, maxLines) {
  if (out.length >= maxLines || !line.trim()) return;
  try {
    out.push(JSON.parse(line));
  } catch {
    /* not our line to interpret */
  }
}

/**
 * Scan all `ses:` docs (small registry); used for the native-id duplicate guard.
 *
 * @access private
 * @param {Pick<import('sumo/db').SumoDb, 'scan'>} db - Database client used to read session docs.
 * @returns {Promise<SessionDoc[]>} Session registry documents currently stored in the daemon.
 */
async function sessionDocs(db) {
  /** @type {SessionDoc[]} */
  const docs = [];
  for await (const [, doc] of db.scan('ses:')) docs.push(/** @type {SessionDoc} */ (doc));
  return docs;
}

/**
 * Durable per-file byte watermark, so a daemon restart resumes instead of re-ingesting.
 *
 * @access private
 * @param {string} harness - Harness supplied to `tailmarkKey`.
 * @param {string} file - Path read or written by `tailmarkKey`.
 * @returns {string} String returned by `tailmarkKey`.
 */
function tailmarkKey(harness, file) {
  return `tailmark:${harness}:${file}`;
}

/**
 * Start watching every tail-capable acquirer's transcript root and auto-ingesting new transcripts.
 *
 * @access public
 * @param {WatcherOptions} opts - Watcher dependencies and lifecycle settings.
 * @returns {{ stop: () => Promise<void>, ready: Promise<void> }} Watcher handle with readiness and shutdown controls.
 */
export function watcher({
  db, adapters, isInScope = () => true, resolveRoot = (a) => a.transcriptRoot(), fromStart = false, debounceMs = 400, idleEndMs = 15_000, signal = NEVER_ABORT, log = () => {}
}) {
  /** @type {Map<string, { stop: () => void }>} path → active tail handle (one tail per file). */
  const tailing = new Map();
  /** @type {Set<string>} paths currently being correlated (re-entrancy guard). */
  const inflight = new Set();
  /** @type {Set<Promise<void>>} file-resolution tasks that stop() must drain. */
  const active = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} path → debounce timer (let the harness write its doc first). */
  const debounce = new Map();
  /** @type {Set<ReturnType<typeof setTimeout>>} delayed new-directory scans. */
  const treeScans = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId → idle→ended timer (foreign sessions only). */
  const idleTimers = new Map();
  /** @type {import('chokidar').FSWatcher[]} */
  const watchers = [];
  /** @type {Array<Promise<void>>} */
  const readyWaits = [];
  /** @type {Array<() => void>} scans that reconcile files created while a watcher is settling. */
  const readyScans = [];
  // Filesystems and instrumented test runs can expose mtimes with coarser precision than Date.now().
  // Keep a startup grace window so files created while chokidar is settling are not mistaken for old
  // archive entries. Old archives are still filtered by age; active sessions win over strict replay
  // avoidance near daemon start.
  const startedAt = Date.now() - 5000;
  let stopped = false;

  /**
   * Decide the Sumo session id to ingest `file` under, applying the service-owned policy. Returns null
   * when the transcript must be SKIPPED (out of scope, ambiguous, or no correlation signal).
   *
   * @access public
   * @param {ArtifactAcquirer} acquirer - Artifact acquirer for the transcript file.
   * @param {string} file - Path read or written by `resolveSessionId`.
   * @returns {Promise<string|null>} Sumo session id to ingest under, or `null` when the file should be skipped.
   */
  async function resolveSessionId(acquirer, file) {
    const records = readHead(file);
    const signals = /** @type {Record<string, unknown>} */ (acquirer.signals({
      transcriptPath: file,
      records: /** @type {Record<string, unknown>[]} */ (records)
    }));

    // 1) Recorded/heuristic correlation to an EXISTING ses: doc (the daemon-spawned or already-known case).
    const corr = await correlate(db, { harness: acquirer.id, transcriptPath: file, signals });
    if (corr.ok) {
      const corrValue = /** @type {import('zod').infer<typeof import('./base/schema.mjs').Correlation>} */ (corr.value);
      const sumoId = corrValue.sumoId;
      // Do NOT double-ingest a session that CURRENTLY has a live stream: its harness read loop is
      // already the source of truth in the DB, and cross-source dedupe collapse is not reliable for
      // id-less Codex/Cursor events. Only skip when the doc is STILL RUNNING as event-stream — meaning
      // an active harness is presumably feeding the stream right now. If the session has ended/crashed
      // (state != 'running'), or after a daemon restart where the orchestrator has no live handle, the
      // transcript IS the only remaining source and must be ingested.
      const doc = /** @type {SessionDoc|null} */ (await db.get(key(sumoId)).catch(() => null));
      if (doc?.observationSource === 'event-stream' && doc?.state === 'running') {
        log(`ingest: skip ${file} — actively live-streamed session ${sumoId} (state=running, source=event-stream)`);
        return null;
      }
      return sumoId;
    }

    // 2) Ambiguous → never guess which session this belongs to.
    if (corr.code === 'SUMO_AMBIGUOUS') {
      log(`ingest: skip ${file} — ambiguous correlation (${corr.reason})`);
      return null;
    }

    // 3) Genuinely foreign (no matching doc). Only ingest when we can prove project scope: we need a
    //    cwd to gate on (Claude/Codex carry it; Cursor does not, so a foreign Cursor session is skipped).
    const cwd = typeof signals.cwd === 'string' ? signals.cwd : undefined;
    if (!cwd) {
      log(`ingest: skip ${file} — foreign session with no cwd signal (cannot scope ${acquirer.id})`);
      return null;
    }
    if (!isInScope(cwd)) {
      log(`ingest: skip ${file} — cwd ${cwd} is outside any Sumo-managed project`);
      return null;
    }

    // 4) In-scope foreign: mint ONE passthrough ses: doc, guarded against the harness's concurrent write
    //    (a Sumo-spawned session may not have patched its harnessSessionId yet — re-check by native id).
    const nativeId = typeof signals.nativeId === 'string' ? signals.nativeId : undefined;
    if (nativeId) {
      const existing = (await sessionDocs(db)).find((d) => d.harness === acquirer.id && d.harnessSessionId === nativeId);
      if (existing) return existing.id;
    }
    const sessionId = id();
    const now = Date.now();
    const doc = withDefined({
      id: sessionId, harness: acquirer.id, cwd, state: 'observed', // not 'running'/'ended': a foreign session has no live Sumo handle (non-controllable)
      createdAt: now, updatedAt: now, transcriptPath: file, ext: { foreign: true }
    }, { harnessSessionId: nativeId });
    await db.put(key(sessionId), doc);
    log(`ingest: observing foreign ${acquirer.id} session ${sessionId} (native ${nativeId}) at ${file}`);
    return sessionId;
  }

  /**
   * A foreign `observed` session has no live Sumo handle to fire a terminal event, so flip it to
   * `ended` once its transcript has been idle (no appends) for `idleEndMs` — otherwise `observed` docs
   * would never reach a terminal state (and `session-await-ended` on one would only ever time out).
   * Re-armed on every tail progress; cleared on stop.
   *
   * @access public
   * @param {string} sessionId - Identifier used by `armIdleEnd`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function armIdleEnd(sessionId) {
    if (idleEndMs <= 0) return;
    // Read the doc to check ext.foreign — this survives daemon restarts, unlike the old in-memory
    // foreignMinted Set which was empty after restart and caused foreign sessions to stay 'observed'
    // forever. Best-effort: if the read fails, skip silently rather than arm for non-foreign sessions.
    /** @type {SessionDoc|undefined} */
    let doc;
    try { doc = /** @type {SessionDoc|undefined} */ (await db.get(key(sessionId))); } catch { return; }
    if (!doc?.ext?.foreign) return;
    clearTimeout(idleTimers.get(sessionId));
    const t = setTimeout(() => {
      idleTimers.delete(sessionId);
      const patch = { state: 'ended', updatedAt: Date.now() };
      void db.mergeDoc(key(sessionId), patch).catch(() => {});
      log(`ingest: foreign session ${sessionId} idle ${idleEndMs}ms → ended`);
    }, idleEndMs);
    t.unref();
    idleTimers.set(sessionId, t);
  }

  /**
   * Resolve a discovered transcript and start exactly one durable tail for it.
   *
   * @access public
   * @param {import('./base/Artifacts.mjs').Artifacts} acquirer - Acquirer supplied to `onFile`.
   * @param {string} file - Path read or written by `onFile`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function onFile(acquirer, file) {
    if (stopped) return;
    if (!file.endsWith('.jsonl')) return;
    if (tailing.has(file) || inflight.has(file)) return;
    inflight.add(file);
    try {
      const sessionId = await resolveSessionId(acquirer, file);
      if (!sessionId) return;
      if (tailing.has(file)) return; // raced
      // Resume from the durable watermark; first sight (no mark) → offset 0 captures the active session
      // in full. ignoreInitial keeps OLD ended files (no appends) from ever being tailed (no archive replay).
      const mark = /** @type {{ offset?: unknown }|null} */ (await db.get(tailmarkKey(acquirer.id, file)).catch(() => null));
      const startOffset = typeof mark?.offset === 'number' ? mark.offset : 0;
      const key = tailmarkKey(acquirer.id, file);
      void armIdleEnd(sessionId); // arm now; re-armed on each progress below
      const handle = acquirer.tail(file, {
        db: /** @type {import('./base/Artifacts.mjs').ArtifactDb} */ (/** @type {unknown} */ (db)),
        sessionId,
        signal,
        startOffset,
        /**
         * Persist the transcript watermark only after its complete lines have committed.
         *
         * @access public
         * @param {number} offset - Offset supplied to `onProgress`.
         * @returns {Promise<void>} Persists the tail watermark and re-arms foreign-session idle detection.
         */
        async onProgress(offset) {
          await db.put(key, { offset });
          await armIdleEnd(sessionId);
        }
      });
      if (!handle.ok) {
        log(`ingest: tail unavailable for ${file} — ${handle.reason}`);
        return;
      }
      tailing.set(file, /** @type {import('./tail.mjs').TailHandle} */ (handle.value));
    } catch (err) {
      log(`ingest: error handling ${file} — ${err?.message ?? err}`);
    } finally {
      inflight.delete(file);
    }
  }

  for (const acquirer of adapters) {
    if (!acquirer.can.tail) continue;
    const root = resolveRoot(acquirer);
    if (!root) continue;
    // Native-event discovery (NOT polling): cheap over a large tree. Per-file tailing polls separately.
    // ignoreInitial skips the pre-existing archive — we ingest only sessions active after the daemon starts.
    const depth = 12;
    const watcher = watch(root, { ignoreInitial: !fromStart, persistent: true, depth });
    let watcherReady = false;
    // Debounce per file: a Sumo-spawned session's transcript can appear before the harness has written
    // its ses: doc (esp. the `harnessSessionId` patch). Waiting `debounceMs` lets that write land first,
    // so the recorded-correlation / live-streamed-skip path wins the race rather than minting a foreign
    // doc. startOffset:0 on first sight means the delay loses no content.
    /**
     * Debounce transcript discovery until the harness has written its session correlation doc.
     *
     * @access public
     * @param {string} p - P supplied to `schedule`.
     * @param {number} minMtimeMs - Minimum mtime accepted for new files during watcher settlement.
     * @returns {void} Schedules or skips a debounced file ingestion attempt.
     */
    function schedule(p, minMtimeMs = -Infinity) {
      if (stopped || !p.endsWith('.jsonl') || tailing.has(p)) return;
      if (Number.isFinite(minMtimeMs)) {
        let stat;
        try {
          stat = fs.statSync(p);
        } catch {
          return;
        }
        if (stat.mtimeMs < minMtimeMs) return;
      }
      clearTimeout(debounce.get(p));
      const t = setTimeout(() => {
        debounce.delete(p);
        const task = onFile(acquirer, p).finally(() => active.delete(task));
        active.add(task);
      }, debounceMs);
      debounce.set(p, t);
    }
    /**
     * Scan a newly-created directory for transcript files that may have been written before chokidar
     * attached to the child directory. This preserves ignoreInitial for old roots while making new
     * project directories lossless under fast create-dir/write-file sequences.
     *
     * @access public
     * @param {string} dir - Filesystem location used by `scheduleTree`.
     * @param {number} seenDepth - Seen depth supplied to `scheduleTree`.
     * @param {number} minMtimeMs - Min mtime ms supplied to `scheduleTree`.
     * @returns {void} Recursively schedules eligible transcript files below `dir`.
     */
    function scheduleTree(dir, seenDepth = 0, minMtimeMs = -Infinity) {
      if (stopped || seenDepth > depth) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scheduleTree(entryPath, seenDepth + 1, minMtimeMs);
        } else {
          if (Number.isFinite(minMtimeMs)) {
            let stat;
            try {
              stat = fs.statSync(entryPath);
            } catch {
              continue;
            }
            if (stat.mtimeMs < minMtimeMs) continue;
          }
          schedule(entryPath, minMtimeMs);
        }
      }
    }
    /**
     * Scan a directory now and during the watcher-settling window. Some filesystem backends emit addDir
     * before the writer has flushed the transcript file into that directory, and instrumented runs can
     * also create the child file while recursive native watchers are still attaching. The bounded burst
     * keeps active-session discovery lossless without turning old archive roots into a polling scan.
     *
     * @access public
     * @param {string} dir - Filesystem location used by `scanSettlingDir`.
     * @param {number} minMtimeMs - Min mtime ms supplied to `scanSettlingDir`.
     * @returns {void} Performs bounded rescans for files created while watchers settle.
     */
    function scanSettlingDir(dir, minMtimeMs) {
      scheduleTree(dir, 0, minMtimeMs);
      const scanDelays = [
      debounceMs, debounceMs * 2, debounceMs * 4, Math.max(250, debounceMs * 8), Math.max(1000, debounceMs * 16)
      ];
      for (const delay of scanDelays) {
        const t = setTimeout(() => {
          treeScans.delete(t);
          scheduleTree(dir, 0, minMtimeMs);
        }, delay);
        t.unref();
        treeScans.add(t);
      }
    }
    const minDiscoveredMtime = fromStart ? -Infinity : startedAt;
    watcher.on('add', (p) => schedule(p, minDiscoveredMtime));
    watcher.on('change', (p) => schedule(p, minDiscoveredMtime));
    watcher.on('addDir', (dir) => {
      if (watcherReady && dir !== root) scanSettlingDir(dir, minDiscoveredMtime);
    });
    // Without this, chokidar errors (ENOENT if the root doesn't exist yet, EACCES, etc.) become
    // unhandled EventEmitter errors and crash the daemon. Best-effort: log and continue.
    watcher.on('error', (err) => { log(`ingest: watcher error on ${root} — ${err instanceof Error ? err.message : err}`); });
    watchers.push(watcher);
    readyScans.push(() => scanSettlingDir(root, minDiscoveredMtime));
    readyWaits.push(new Promise((res) => watcher.once('ready', () => {
      watcherReady = true;
      res();
    })));
  }

  const ready = Promise.all(readyWaits).then(() => {
    for (const scan of readyScans) scan();
  });

  /**
   * Stop all watchers and active tails owned by this ingestion service instance.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function stop() {
    stopped = true;
    for (const t of debounce.values()) clearTimeout(t);
    debounce.clear();
    for (const t of treeScans) clearTimeout(t);
    treeScans.clear();
    await Promise.allSettled(active);
    active.clear();
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
    for (const handle of tailing.values()) {
      try { await handle.stop(); } catch { /* best-effort */ }
    }
    tailing.clear();
    await Promise.all(watchers.map((w) => w.close().catch(() => {})));
  }
  signal.addEventListener('abort', () => { void stop(); }, { once: true });

  return { stop, ready };
}
