/**
 * Contract tests for `sumo/capability` — the define-once shape, its validator, and the serializable
 * catalog entry the generators read. Exercised against the REAL zod runtime (CONVENTIONS §5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { create, toJSON, CapabilitySchema, EntrySchema, SURFACES } from 'sumo/capability';

test('capability definitions validate, freeze, serialize and reject invalid contracts', /** Verify capability definitions validate, freeze, serialize and reject invalid contracts. */ () => {
  const cap = create({
    name: 'greet',
    title: 'Greet',
    description: 'say hello',
    inputSchema: z.object({ who: z.string() }),
    /** Implement exec. */ exec(input) { return ({ hello: input.who }); }
  });
  assert.equal(cap.name, 'greet');
  assert.deepEqual(cap.surfaces, [...SURFACES]);
  assert.equal(typeof cap.exec, 'function');
  assert.ok(Object.isFrozen(cap), 'capability is frozen');

  assert.deepEqual(create({
    name: 'internal',
    title: 'Internal',
    description: 'programmatic only',
    surfaces: ['programmatic'],
    /** Implement exec. */ exec() { return 1; }
  }).surfaces, ['programmatic']);
  assert.equal(create({ name: 'ping', title: 'Ping', description: '', /** Implement exec. */ exec() { return 'pong'; } }).inputSchema, undefined);

  assert.throws(/** Run the callback. */ () => create({ name: 'x', title: 'X', description: '' }), /invalid capability 'x'.*exec/s);
  assert.throws(/** Run the callback. */ () => create({ name: '', title: 'X', description: '', /** Implement exec. */ exec() { return 1; } }), /invalid capability/);
  assert.throws(
    /** Run the callback. */ () => create({ name: 'x', title: 'X', description: '', inputSchema: { not: 'zod' }, /** Implement exec. */ exec() { return 1; } }),
    /must be a zod schema/
  );
  assert.throws(/** Run the callback. */ () => create(null), /invalid capability '\(unnamed\)'.*\(root\)/s);
  assert.equal(
    CapabilitySchema.safeParse({ name: 'x', title: 'X', description: '', surfaces: [], /** Implement exec. */ exec() { return 1; } }).success,
    false
  );

  const serializable = create({
    name: 'mk',
    title: 'Make',
    description: 'make a thing',
    inputSchema: z.object({
      name: z.string().describe('the name'),
      count: z.number().optional(),
      force: z.boolean().default(false),
      mode: z.enum(['fast', 'slow'])
    }),
    /** Implement exec. */ exec() { return ({}); }
  });
  const entry = toJSON(serializable, { plugin: 'demo' });
  assert.equal(EntrySchema.safeParse(entry).success, true);
  assert.equal(entry.plugin, 'demo');
  assert.equal(entry.inputSchema.type, 'object');
  assert.equal(entry.inputSchema.properties.name.type, 'string');
  assert.equal(entry.inputSchema.properties.name.description, 'the name');
  assert.equal(entry.inputSchema.properties.count.type, 'number');
  assert.equal(entry.inputSchema.properties.force.type, 'boolean');
  assert.equal(entry.inputSchema.properties.force.default, false);
  assert.deepEqual(entry.inputSchema.properties.mode.enum, ['fast', 'slow']);
  assert.deepEqual(entry.inputSchema.required.sort(), ['force', 'mode', 'name']);
  assert.equal(entry.inputSchema.required.includes('count'), false);

  const noSchema = toJSON(create({ name: 'pong', title: 'Pong', description: '', /** Implement exec. */ exec() { return 'pong'; } }));
  assert.equal(noSchema.inputSchema, undefined);
  assert.equal('plugin' in noSchema, false);
  assert.equal(toJSON(create({
    name: 'custom',
    title: 'Custom',
    description: 'custom validator',
    inputSchema: z.custom(/** Run the callback. */ () => true),
    /** Implement exec. */ exec() { return 'ok'; }
  })).inputSchema, undefined);

  const output = toJSON(create({
    name: 'list',
    title: 'List',
    description: 'list things',
    outputSchema: z.array(z.object({ id: z.string() })),
    annotations: { readOnlyHint: true },
    /** Implement exec. */ exec() { return []; }
  }));
  assert.equal(output.outputSchema.type, 'array');
  assert.equal(output.outputSchema.items.type, 'object');
  assert.deepEqual(output.annotations, { readOnlyHint: true });

  const frozen = create({
    name: 'x',
    title: 'X',
    description: '',
    surfaces: ['cli', 'programmatic'],
    annotations: { readOnlyHint: true },
    /** Implement exec. */ exec() { return 1; }
  });
  assert.ok(Object.isFrozen(frozen.surfaces), 'surfaces frozen');
  assert.ok(Object.isFrozen(frozen.annotations), 'annotations frozen');
  assert.throws(/** Run the callback. */ () => frozen.surfaces.push('mcp'), TypeError);

  const copy = toJSON(frozen);
  copy.surfaces.push('mcp');
  copy.annotations.readOnlyHint = false;
  assert.deepEqual(frozen.surfaces, ['cli', 'programmatic'], 'definition surfaces unchanged');
  assert.equal(frozen.annotations.readOnlyHint, true, 'definition annotations unchanged');
});
