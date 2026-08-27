/**
 * Append-only file tailer (tail-`-f` semantics). chokidar signals "this file changed"; the actual
 * acquisition work — tracking a byte offset, reading only the appended bytes, and buffering a trailing
 * partial line until its newline arrives — is owned here (it is the same regardless of watcher).
 *
 * This is pure I/O/framing: it emits complete lines in order. It does NOT parse them (that is
 * `sumo/transcript`, §3d); the caller `JSON.parse`s each line and delegates to the parser.
 *
 * Scope: these harness transcripts are append-only, one file per session — so log rotation (replacing
 * the file with a fresh one that re-grows past the old offset before the next poll) is out of scope;
 * only truncation (`size < offset`) is handled. `fromStart:false` tails bytes appended after the
 * watcher's baseline; a write between `tail()` and that baseline is treated as pre-existing.
 *
 * @module sumo/agent-artifacts/tail
 */

import { watch } from 'chokidar';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Live tail control handle.
 *
 * @typedef {{ stop: () => Promise<void>, ready: Promise<void> }} TailHandle
 */

/**
 * Tail an append-only file, invoking `onLine` with each complete (newline-terminated) line in order.
 * A write that ends mid-record leaves the partial line buffered until the next write completes it.
 *
 * @access public
 * @param {string} path - file to tail.
 * @param {(line: string) => void|Promise<void>} onLine - called per complete, non-empty line, in append order.
 * @param {{ signal?: AbortSignal, fromStart?: boolean, startOffset?: number, onProgress?: (offset: number) => void|Promise<void> }} opts - Options read by this operation.
 * @returns {TailHandle} Live tail control handle.
 */
export function tail(path, onLine, { signal, fromStart = true, startOffset, onProgress } = {}) {
  let offset = 0;
  let buffer = '';
  let draining = false;
  let again = false;
  let closed = false;
  let baselineReady = false;
  /** @type {Promise<void>} Current serialized read/drain operation. */
  let inFlight = Promise.resolve();
  /** @type {ReturnType<typeof setInterval>|undefined} */
  let pollTimer;
  // Decodes bytes incrementally: a multi-byte UTF-8 code point split across two reads is held until
  // its remaining bytes arrive, instead of emitting replacement chars (which would corrupt payload
  // text and its content-hash dedupe key).
  let decoder = new StringDecoder('utf8');

  /**
   * Deliver complete buffered lines in order. A rejected callback leaves its line in the buffer so a
   * later poll retries it instead of advancing past an uncommitted record.
   *
   * @access private
   * @returns {Promise<void>} Resolves after all complete buffered lines have been acknowledged.
   */
  async function drainLines() {
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      if (closed) return;
      if (line.trim()) await onLine(line);
      buffer = buffer.slice(nl + 1);
    }
  }

  /**
   * Read appended bytes from `offset` to EOF, framing complete lines.
   * Self-coalescing: a change that lands mid-read re-loops once so no event is lost or double-read.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function readNew() {
    if (closed) return;
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        let size;
        try {
          size = (await stat(path)).size;
        } catch {
          break; // file vanished mid-tail; stop quietly
        }
        if (closed) break;
        if (size < offset) {
          // truncated/rotated underneath us → restart from the top (reset the decoder too)
          offset = 0;
          buffer = '';
          decoder = new StringDecoder('utf8');
        }
        await drainLines();
        if (size > offset) {
          const fh = await open(path, 'r');
          try {
            const len = size - offset;
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, offset);
            if (closed) break;
            offset += bytesRead;
            // decoder.write holds an incomplete trailing multi-byte sequence until the next read.
            buffer += decoder.write(buf.subarray(0, bytesRead));
          } finally {
            await fh.close();
          }
          await drainLines();
          // A partial trailing line has not been durably ingested, so only advance the watermark when
          // the buffer is empty. Replaying an already-committed prefix after a crash is safe because
          // event dedupe is idempotent; skipping a partial record is not.
          if (!buffer) await onProgress?.(offset);
        }
      } while (!closed && again);
    } finally {
      draining = false;
    }
  }

  // Polling, not native fsevents: a tailer must catch EVERY append (including the last). Native
  // backends on macOS coalesce/drop rapid successive writes to the same file — proven to miss the
  // final append in testing — so we poll the file size on a short interval instead.
  const watcher = watch(path, { ignoreInitial: true, persistent: true, usePolling: true, interval: 50 });
  /**
   * Coalesce file watcher notifications into the serialized drain loop.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  function onEvent() {
    if (closed || !baselineReady) return;
    if (draining) {
      again = true;
      return;
    }
    inFlight = readNew();
    void inFlight.catch(() => {});
  }
  watcher.on('change', onEvent);
  watcher.on('add', onEvent);
  const watcherReady = new Promise((res) => watcher.once('ready', () => res(undefined)));

  // `ready` resolves only after the watcher has established its polling baseline AND the pre-existing
  // content has been read. A caller that appends after `await ready` is therefore guaranteed to be
  // seen — appending before the baseline exists would otherwise be folded into it and never fire.
  const ready = (async () => {
    await watcherReady;
    if (startOffset != null) {
      offset = startOffset; // durable resume: start exactly where a prior run left off
    } else if (!fromStart) {
      try {
        offset = (await stat(path)).size;
      } catch {
        offset = 0;
      }
    }
    baselineReady = true;
    inFlight = readNew();
    await inFlight;
    pollTimer = setInterval(onEvent, 50);
    pollTimer.unref();
  })();

  /**
   * Stop the polling watcher; callers may invoke it repeatedly.
   *
   * @access public
   * @returns {Promise<void>} Resolves once any in-flight line ingestion has settled.
   */
  async function stop() {
    if (closed) {
      await inFlight.catch(() => {});
      return;
    }
    closed = true;
    again = false;
    if (pollTimer) clearInterval(pollTimer);
    await watcher.close().catch(() => {});
    await inFlight.catch(() => {});
  }
  signal?.addEventListener('abort', () => { void stop(); }, { once: true });

  return { stop, ready };
}
