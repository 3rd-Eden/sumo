import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderResult, renderDiagnostics, renderTable } from '../src/render.mjs';

/** Collect rendered lines into an array for assertions. */
function sink() {
  const lines = [];
  return { /** Implement out. */ out(l) { return lines.push(l); }, lines, /** Implement text. */ text() { return lines.join('\n'); } };
}

test('render helpers handle human, json, failure, diagnostic and table output', /** Verify render helpers handle human, json, failure, diagnostic and table output. */ () => {
  let s = sink();
  assert.equal(renderResult({ ok: true, value: 'hello' }, { out: s.out }), true);
  assert.deepEqual(s.lines, ['hello']);

  s = sink();
  assert.equal(renderResult({ ok: true }, { out: s.out }), true);
  assert.match(s.text(), /ok/);

  s = sink();
  assert.equal(renderResult({ ok: false, code: 'SUMO_NO_COMMAND', reason: 'no command foo' }, { out: s.out }), false);
  assert.match(s.text(), /SUMO_NO_COMMAND/);
  assert.match(s.text(), /no command foo/);

  s = sink();
  const wrappedFailure = { ok: true, value: { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'nope' } };
  assert.equal(renderResult(wrappedFailure, { out: s.out }), false);
  assert.match(s.text(), /SUMO_CAP_UNSUPPORTED/);

  s = sink();
  renderResult({ ok: true, value: { ok: true, value: { passed: true } } }, { json: true, out: s.out });
  assert.deepEqual(JSON.parse(s.text()), { ok: true, value: { passed: true } });

  s = sink();
  renderDiagnostics([], { out: s.out });
  assert.match(s.text(), /no diagnostics/);

  s = sink();
  renderDiagnostics(
    [{ code: 'SUMO_PLUGIN_CONFIG_INVALID', message: 'bad slice', severity: 'error', source: { plugin: 'github' } }],
    { out: s.out }
  );
  assert.match(s.text(), /SUMO_PLUGIN_CONFIG_INVALID/);
  assert.match(s.text(), /bad slice/);
  assert.match(s.text(), /github/);

  s = sink();
  const diags = [{ code: 'X', message: 'm', severity: 'warning', source: {} }];
  renderDiagnostics(diags, { json: true, out: s.out });
  assert.deepEqual(JSON.parse(s.text()), diags);

  s = sink();
  renderTable(
    [
      { id: 'ses_a', state: 'running' },
      { id: 'ses_bb', state: 'done' }
    ],
    [
      { key: 'id', header: 'ID' },
      { key: 'state', header: 'STATE' }
    ],
    { out: s.out }
  );
  assert.equal(s.lines.length, 3);
  assert.match(s.lines[0], /^ID/);
  assert.match(s.lines[1], /ses_a/);
  assert.ok(s.lines[1].startsWith('ses_a '.padEnd(6)));

  s = sink();
  const rows = [{ seq: 1, type: 'a' }];
  renderTable(rows, [{ key: 'seq' }, { key: 'type' }], { json: true, out: s.out });
  assert.deepEqual(JSON.parse(s.text()), rows);

  s = sink();
  renderTable([{ a: 1 }], [{ key: 'a' }, { key: 'b' }], { out: s.out });
  assert.equal(s.lines.length, 2);
});
