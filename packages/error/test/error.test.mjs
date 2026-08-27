import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SumoError, ErrorSchema, docs, ok, fail, isResult, unwrapNestedResult, CAP_UNSUPPORTED } from '../src/index.mjs';
import { DiagnosticSchema } from 'sumo/config';

const DOCS_BASE = 'https://github.com/3rd-Eden/sumo/blob/main/docs/errors.md';

test('error package preserves docs, Result shape, serialization, causes and wrapping semantics', /** Verify error package preserves docs, Result shape, serialization, causes and wrapping semantics. */ () => {
  assert.equal(docs({ code: 'SUMO_NO_DAEMON' }), `${DOCS_BASE}#error-sumo-no-daemon`);
  assert.equal(docs({ code: 'SUMO_PLUGIN_CONFIG_INVALID' }), `${DOCS_BASE}#error-sumo-plugin-config-invalid`);
  assert.equal(docs({ code: 'SUMO_CUSTOM', docs: 'https://example.test/errors.md' }), 'https://example.test/errors.md#error-sumo-custom');

  assert.deepEqual(ok(), { ok: true });
  assert.deepEqual(ok(42), { ok: true, value: 42 });
  assert.deepEqual(fail(CAP_UNSUPPORTED, 'not available'), { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'not available' });
  assert.equal(isResult(ok(1)), true);
  assert.equal(isResult(fail('SUMO_X', 'x')), true);
  assert.equal(isResult({ ok: true }), true);
  assert.equal(isResult({ value: 1 }), false);
  assert.deepEqual(unwrapNestedResult({ ok: true, value: fail('SUMO_X', 'x') }), fail('SUMO_X', 'x'));
  assert.deepEqual(unwrapNestedResult(ok({ value: 1 })), { ok: true, value: { value: 1 } });

  const err = new SumoError({ name: 'db', method: 'connect', code: 'SUMO_NO_DAEMON', message: 'no daemon' });
  assert.equal(err.message, `sumo/db(connect): no daemon\n\nFor more information visit: ${DOCS_BASE}#error-sumo-no-daemon`);
  assert.equal(err.message.match(/For more information visit/g).length, 1);
  assert.equal(err.name, 'SumoError');
  assert.equal(err.package, 'sumo/db');
  assert.equal(err.method, 'connect');
  assert.equal(err.code, 'SUMO_NO_DAEMON');
  assert.equal(err.reason, 'no daemon');
  assert.equal(err.docs, `${DOCS_BASE}#error-sumo-no-daemon`);
  assert.ok(err instanceof SumoError);
  assert.ok(err instanceof Error);

  const named = new SumoError({
    name: 'db', method: 'connect', code: 'SUMO_NO_DAEMON',
    message: 'no daemon at {sock}', vars: { sock: '/tmp/s.sock' }
  });
  assert.equal(named.reason, 'no daemon at /tmp/s.sock');
  const positional = new SumoError({ name: 'cli', method: 'invoke', code: 'SUMO_INVALID_ARGUMENT', message: 'bad %s for %s', args: ['max', 'run'] });
  assert.equal(positional.reason, 'bad max for run');
  const unresolved = new SumoError({
    name: 'cli',
    method: 'invoke',
    code: 'SUMO_INVALID_ARGUMENT',
    message: 'bad {missing} {unset} %s %s',
    vars: { unset: undefined },
    args: ['value']
  });
  assert.equal(unresolved.reason, 'bad {missing} {unset} value %s');

  const scoped = new SumoError({ name: '@scope/pkg', method: 'run', code: 'SUMO_SCOPED', message: 'scoped' });
  assert.equal(scoped.package, '@scope/pkg');
  assert.match(scoped.message, /^@scope\/pkg\(run\): scoped/);
  const custom = new SumoError({ name: 'pkg', method: 'run', code: 'SUMO_CUSTOM_SCOPE', message: 'custom', scope: 'workspace' });
  assert.equal(custom.package, 'workspace/pkg');

  const extra = new SumoError({ name: 'messenger', method: 'claim', code: 'SUMO_CLAIM_HELD', message: 'held', status: 409 });
  assert.equal(extra.status, 409);
  assert.equal(extra.toJSON().status, 409);

  const json = JSON.parse(JSON.stringify(err));
  assert.equal(json.package, 'sumo/db');
  assert.equal(json.method, 'connect');
  assert.equal(json.code, 'SUMO_NO_DAEMON');
  assert.equal(json.reason, 'no daemon');
  assert.equal(json.severity, 'error');
  assert.equal(json.docs, `${DOCS_BASE}#error-sumo-no-daemon`);
  assert.ok(typeof json.stack === 'string' && json.stack.length > 0);

  const codeErr = new SumoError({ name: 'harness', method: 'open', code: 'SUMO_NOT_IMPLEMENTED', message: 'm' });
  assert.equal(codeErr.code, 'SUMO_NOT_IMPLEMENTED');
  assert.equal(codeErr.toJSON().code, 'SUMO_NOT_IMPLEMENTED');
  assert.equal(codeErr.docs, `${DOCS_BASE}#error-sumo-not-implemented`);

  const back = SumoError.from(JSON.parse(JSON.stringify(err)));
  assert.ok(back instanceof SumoError);
  assert.equal(back.message, err.message);
  assert.equal(back.message.match(/For more information visit/g).length, 1);
  assert.equal(back.code, 'SUMO_NO_DAEMON');
  assert.equal(back.package, 'sumo/db');
  assert.match(err.stack, /SumoError/);
  assert.doesNotMatch(err.stack.split('\n')[1] ?? '', /new SumoError/);
  assert.equal(back.stack, err.stack);

  const root = new Error('connect ENOENT');
  const inner = new SumoError({ name: 'db', method: 'request', code: 'SUMO_NO_DAEMON', message: 'no daemon', cause: root });
  const outer = SumoError.wrap(inner, { name: 'cli', method: 'invoke', code: 'SUMO_DAEMON_CALL_FAILED', message: 'command failed' });
  const wire = JSON.parse(JSON.stringify(outer));
  assert.equal(wire.code, 'SUMO_DAEMON_CALL_FAILED');
  assert.equal(wire.cause.code, 'SUMO_NO_DAEMON');
  assert.equal(wire.cause.cause.message, 'connect ENOENT');
  const revived = SumoError.from(wire);
  assert.ok(revived.cause instanceof SumoError);
  assert.equal(revived.cause.code, 'SUMO_NO_DAEMON');
  assert.ok(revived.cause.cause instanceof Error);
  assert.equal(revived.cause.cause.message, 'connect ENOENT');

  const objectCause = new SumoError({ name: 'plugin', method: 'load', code: 'SUMO_PLUGIN_FAILED', message: 'failed', cause: { plugin: 'demo' } });
  assert.deepEqual(JSON.parse(JSON.stringify(objectCause)).cause, { plugin: 'demo' });
  assert.deepEqual(SumoError.from(JSON.parse(JSON.stringify(objectCause))).cause, { plugin: 'demo' });
  const withPlainCause = SumoError.from({
    name: 'SumoError',
    package: 'sumo/plugin',
    method: 'load',
    code: 'SUMO_PLUGIN_FAILED',
    reason: 'failed',
    message: 'decorated',
    severity: 'error',
    docs: DOCS_BASE,
    cause: { name: 'TypeError', message: 'bad type', code: 'ERR_BAD_TYPE', stack: 'TypeError: bad type' }
  });
  assert.ok(withPlainCause.cause instanceof Error);
  assert.equal(withPlainCause.cause.name, 'TypeError');
  assert.equal(withPlainCause.cause.code, 'ERR_BAD_TYPE');

  assert.equal(SumoError.wrap(err, { name: 'db', method: 'connect', code: 'SUMO_NO_DAEMON', message: 'no daemon' }), err);
  assert.equal(SumoError.wrap(new Error('boom'), { name: 'cli', method: 'main', code: 'SUMO_WRAPPED' }).reason, 'boom');
  assert.equal(SumoError.wrap('plain failure', { name: 'cli', method: 'main', code: 'SUMO_WRAPPED' }).reason, 'plain failure');

  const localStack = SumoError.from({
    name: 'SumoError',
    package: 'sumo/db',
    method: 'connect',
    code: 'SUMO_NO_DAEMON',
    reason: 'no daemon',
    message: 'decorated',
    severity: 'warning',
    docs: DOCS_BASE,
    cause: null
  });
  assert.equal(localStack.severity, 'warning');
  assert.match(localStack.stack, /SumoError/);

  const diagnostic = new SumoError({ name: 'config', method: 'resolve', code: 'SUMO_CONFIG_INVALID', message: 'bad config' }).toJSON();
  assert.doesNotThrow(/** Run the callback. */ () => ErrorSchema.parse(diagnostic));
  assert.doesNotThrow(/** Run the callback. */ () => DiagnosticSchema.parse(diagnostic));
  assert.equal(ErrorSchema.parse({ ...diagnostic, severity: undefined }).severity, 'error');
});
