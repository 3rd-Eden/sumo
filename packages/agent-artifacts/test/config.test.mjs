/**
 * Config-snapshot parity across all four harnesses (real daemon). Each acquirer declares where its
 * config lives (`configFiles`) and snapshots it through the same path: the blob is stored under a
 * `raw:` key (redacted by the daemon at the storage boundary) and the `config.snapshot` event carries
 * only a `rawRef` + `redacted` flag — never config content. Each fixture is a real-shaped config
 * (scrubbed) carrying planted secrets so redaction is genuinely exercised per harness: a token-shaped
 * value (caught by string-pattern redaction) AND, in the JSON configs, an OPAQUE value under a
 * secret-named key (`DB_PASSWORD`/`refreshSecret`/`credential`) that only **key-based** redaction can
 * catch — proving the snapshot stores JSON structured (object), not as a raw string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import url from 'node:url';

import { adapters, snapshot } from '../src/index.mjs';
import { openTempDb, allEvents } from './_daemon.mjs';

/** The real-shaped, scrubbed config fixture per harness (see fixtures/PROVENANCE.md). */
const CONFIG_FIXTURE = {
  'claude-code': 'claude-code/settings.json',
  copilot: 'copilot/config.json',
  codex: 'codex/config.toml',
  cursor: 'cursor/cli-config.json',
  opencode: 'opencode/opencode.json'
};

/** Implement fixturePath. */ function fixturePath(rel) { return url.fileURLToPath(new URL(`./fixtures/config/${rel}`, import.meta.url)); }

for (const harness of Object.keys(CONFIG_FIXTURE)) {
  test(`${harness}: adapter declares its config location (parity)`, /** Run the callback. */ () => {
    const files = new adapters[harness]().configFiles;
    assert.ok(Array.isArray(files) && files.length > 0, `${harness} must declare configFiles`);
  });

  test(`${harness}: config snapshot is redacted at the raw: boundary; no secret in the event`, /** Run the callback. */ async () => {
    const { db, cleanup } = await openTempDb();
    try {
      const res = await snapshot(db, { harness, sessionId: 'ses_X', path: fixturePath(CONFIG_FIXTURE[harness]) });
      assert.ok(res.ok, JSON.stringify(res));

      // The raw: blob the daemon stored has the planted secret redacted.
      const stored = await db.get(res.value.rawRef);
      const storedStr = typeof stored === 'string' ? stored : JSON.stringify(stored);
      assert.equal(storedStr.includes('PLANTED'), false, `${harness}: planted secret must be redacted in the raw blob`);
      assert.ok(storedStr.includes('[REDACTED'), `${harness}: a redaction marker must be present`);

      // The config.snapshot event links the blob; it carries no config content / secret.
      const evt = (await allEvents(db)).find(/** Find a matching item. */ (e) => e.type === 'config.snapshot');
      assert.ok(evt, `${harness}: config.snapshot must be emitted`);
      assert.equal(evt.payload.redacted, true);
      assert.equal(evt.payload.rawRef, res.value.rawRef);
      assert.equal(evt.sessionId, 'ses_X');
      assert.equal(evt.adapter, harness);
      assert.equal(JSON.stringify(evt).includes('PLANTED'), false, `${harness}: no secret leaks into the event payload`);
    } finally {
      await cleanup();
    }
  });
}

test('config snapshot accepts direct content, plain text files, and reports missing inputs', /** Verify config snapshot accepts direct content, plain text files, and reports missing inputs. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const noInput = await snapshot(db, { harness: 'claude-code', sessionId: 'ses_no_input' });
    assert.equal(noInput.ok, false);
    assert.equal(noInput.code, 'SUMO_BAD_OP');

    const missing = await snapshot(db, { harness: 'claude-code', sessionId: 'ses_missing_config', path: '/definitely/missing/sumo-config.json' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'SUMO_IO');

    const direct = await snapshot(db, { harness: 'codex', sessionId: 'ses_direct', content: { apiKey: 'PLANTED_DIRECT_SECRET' } });
    assert.equal(direct.ok, true);
    assert.equal(direct.value.path, undefined);
    const directEvent = (await allEvents(db)).find(/** Find a matching item. */ (e) => e.sessionId === 'ses_direct' && e.type === 'config.snapshot');
    assert.equal(directEvent.payload.path, undefined);

    const textPath = fixturePath('codex/config.toml');
    const text = await snapshot(db, { harness: 'codex', sessionId: 'ses_text', path: textPath });
    assert.equal(text.ok, true);
    assert.equal(typeof await db.get(text.value.rawRef), 'string', 'non-JSON config remains a redacted text blob');
  } finally {
    await cleanup();
  }
});
