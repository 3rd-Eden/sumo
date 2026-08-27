/**
 * Seam-1 guard (/): proving the session-id *stamping* fix did NOT move the dedupe *key* for
 * the events that actually collapse cross-source.
 *
 * The harness now stamps the Sumo `ses_<ulid>` spine on every event (native id → `ext.nativeSessionId`).
 * Natural ids are scoped by the harness-native session identity, while event envelopes carry the Sumo
 * session spine. Both live and transcript parsers expose the same native identity, so their keys still
 * collapse without allowing one harness id to overwrite another session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Claude } from '../src/index.mjs';
import { forEvent, forContent, join, rename } from 'sumo/db/dedupe';

const SUMO = 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NATIVE = 'b06f2b01-de75-4950-b7c7-8011e0d74fc9';

test('id-less event: stamps the Sumo id + native in ext and hashes the correlated Sumo id', /** Verify session-scoped id-less dedupe. */ () => {
 const evt = { type: 'session.ended', payload: { outcome: 'success' }, sessionId: NATIVE, ext: { native: { x: 1 } } };
 const out = new Claude().toEvent(evt, SUMO); // first toEvent on a fresh harness → position 0

  // The fix: the spine is stamped, the native id is preserved (not lost).
  assert.equal(out.sessionId, SUMO, 'stamped field is the Sumo spine');
  assert.equal(out.ext.nativeSessionId, NATIVE, 'native id recorded in ext');
  assert.equal(out.ext.native.x, 1, 'parser ext.native preserved alongside');

 assert.equal(out.dedupe, forContent({ sessionId: SUMO, kind: evt.type, payload: evt.payload, position: 0 }));
});

test('id-keyed event: key is scoped by its correlated Sumo session', /** Verify id-keyed session scoping. */ () => {
 const evt = { type: 'session.message', id: 'msg_bdrk_X', payload: { role: 'assistant' }, sessionId: NATIVE };
 const out = new Claude().toEvent(evt, SUMO);

 assert.equal(out.sessionId, SUMO, 'stamped field is the Sumo spine');
 assert.equal(out.ext.nativeSessionId, NATIVE, 'native id recorded in ext');
 assert.equal(out.dedupe, join(rename(evt.type), `${SUMO}:${evt.id}`), 'msg:<sumo-session>:<id> natural key');
});

test('cross-source equality: harness toEvent and the agent-artifacts forEvent call agree on the key', /** Verify cross-source equality: harness toEvent and the agent-artifacts forEvent call agree on the key. */ () => {
 // The on-disk source computes `forEvent(evt, { sessionId, position })` identically . For the
 // natural-id events that actually collapse, the key uses the native parser session rather than either
 // stamped Sumo id or position. Both sources must be correlated to the same Sumo session.
 const evt = { type: 'session.tool', id: 'call_abc', payload: {}, sessionId: NATIVE };
 const harnessKey = new Claude().toEvent(evt, SUMO).dedupe;
 const fileKeySameSumo = forEvent(evt, { sessionId: SUMO, position: 99 });
 assert.equal(harnessKey, fileKeySameSumo, 'natural-id key collapses across correlated sources');
 assert.notEqual(harnessKey, forEvent(evt, { sessionId: 'ses_OTHER', position: 99 }));
 assert.equal(harnessKey, `call:${SUMO}:call_abc`);
});
