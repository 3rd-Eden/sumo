/**
 * Config snapshot: capture a harness's config at session start, **redacted and linked** — never copied
 * into the event payload (spec 09 large-file rule + redaction-on-egress).
 *
 * The daemon redacts only `raw:` KV writes, not appended event payloads (`db/daemon/host.mjs`). So the
 * config blob is stored under a `raw:` key (which IS redacted on write) and the `config.snapshot` event
 * carries only `{ rawRef, redacted:true }` — no config content, no secret, in the event itself.
 *
 * @module sumo/agent-artifacts/snapshot
 */

import { readFile } from 'node:fs/promises';
import { join } from 'sumo/db/dedupe';

import { ok, fail, ArtifactRef } from './base/schema.mjs';

/**
 * Snapshot a harness config to a redacted `raw:` blob and emit `config.snapshot`.
 *
 * @access public
 * @param {{ append: Function, put: Function }} db - Database client used by the operation.
 * @param {Record<string, unknown>} opts - Options read by this operation.
 * @returns {Promise<import('./base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `snapshot`.
 */
export async function snapshot(db, { harness, sessionId, path, content }) {
  let value = content;
  if (value === undefined) {
    if (!path) return fail('SUMO_BAD_OP', 'config snapshot: provide path or content');
    let raw;
    try {
      raw = await readFile(String(path), 'utf8');
    } catch (err) {
      return fail('SUMO_IO', `config snapshot: cannot read ${path}: ${err.message}`);
    }
    // Prefer STRUCTURED storage: the daemon's redactor applies key-name redaction (e.g. a `password`
    // key with an opaque value) only to object values — a raw string only gets token-shape redaction.
    // Parse JSON configs to objects; fall back to the raw string for formats we can't parse here
    // (TOML, or JSONC with comments), which still get string-pattern redaction.
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  // Stored under `raw:` → the daemon redacts secret shapes on write (host.mjs putValue).
  const rawRef = `raw:config:${harness}:${sessionId}`;
  await db.put(rawRef, value);
  await db.append({
    dedupe: join('config', `${harness}:${sessionId}`), type: 'config.snapshot', payload: { rawRef, redacted: true, ...(path ? { path } : {}) }, ext: {}, sessionId, source: 'transcript', adapter: harness
  });
  return ok(ArtifactRef.parse({ kind: 'config', ...(path ? { path } : {}), rawRef, summary: { redacted: true } }));
}
