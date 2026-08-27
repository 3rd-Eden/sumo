/**
 * The CLI generator: commander command generation from the catalog (flag parsing/coercion/choices via
 * the real `commander` package) and the catalog-generated `commands` listing. Exercised against a REAL
 * runtime + real commander parsing (CONVENTIONS §5).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { Command } from 'commander';

import { open } from 'sumo/db';
import { plugin, create, toJSON } from 'sumo/plugin';
import { buildCapabilityCommand, capabilityRows, reservedCliCollisions } from '../src/capabilities.mjs';
import { commands, BUILTINS } from '../src/index.mjs';

/** Parse argv through a generated capability command, capturing the args the action receives. */
function runCapabilityCommand(entry, argv) {
  let received;
  const cmd = buildCapabilityCommand(entry, /** Run the callback. */ (name, args) => { received = { name, args }; });
  const program = new Command('sumo').exitOverride();
  program.addCommand(cmd);
  program.parse([entry.name, ...argv], { from: 'user' });
  return received;
}

/** Implement sink. */ function sink() {
  const lines = [];
  return { /** Implement out. */ out(l) { return lines.push(l); }, lines, /** Implement text. */ text() { return lines.join('\n'); } };
}

let ctx;
before(/** Run the before hook. */ async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-cli-cap-'));
  const db = await open({ home, idleShutdownMs: 5000 });
  ctx = { home, db };
});
after(/** Run the after hook. */ async () => {
  await ctx.db.close();
  try { process.kill(Number(fs.readFileSync(path.join(ctx.home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(ctx.home, { recursive: true, force: true });
});

/** Implement createRuntime. */ function createRuntime() {
  return plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
}

test('CLI capability generation uses real commander parsing and runtime catalog listing', /** Verify CLI capability generation uses real commander parsing and runtime catalog listing. */ async () => {
  const entry = toJSON(
    create({
      name: 'mk',
      title: 'Make',
      description: 'make',
      inputSchema: z.object({
        name: z.string(),
        count: z.number().optional(),
        force: z.boolean().default(false),
        mode: z.enum(['fast', 'slow'])
      }),
      /** Implement exec. */ exec() { return ({}); }
    })
  );
  const { name, args } = runCapabilityCommand(entry, ['--name', 'x', '--count', '5', '--force', '--mode', 'fast']);
  assert.equal(name, 'mk');
  assert.equal(args.name, 'x');
  assert.equal(args.count, 5); // commander argParser(Number) coerced it
  assert.equal(args.force, true); // boolean flag
  assert.equal(args.mode, 'fast');

  const enumEntry = toJSON(
    create({
      name: 'mk',
      title: 'Make',
      description: 'make',
      inputSchema: z.object({ mode: z.enum(['fast', 'slow']) }),
      /** Implement exec. */ exec() { return ({}); }
    })
  );
  assert.throws(/** Run the callback. */ () => runCapabilityCommand(enumEntry, ['--mode', 'warp']), /allowed choices|warp/i);

  const requiredEntry = toJSON(
    create({
      name: 'mk',
      title: 'Make',
      description: 'make',
      inputSchema: z.object({ name: z.string() }),
      /** Implement exec. */ exec() { return ({}); }
    })
  );
  assert.throws(/** Run the callback. */ () => runCapabilityCommand(requiredEntry, []), /required option|--name/i);

  const noInputEntry = toJSON(
    create({ name: 'ping', title: 'Ping', description: '', /** Implement exec. */ exec() { return 'pong'; } })
  );
  const noInput = runCapabilityCommand(noInputEntry, []);
  assert.equal(noInput.name, 'ping');
  assert.deepEqual(noInput.args, {});

  const rt = createRuntime();
  /** Implement demo. */ function demo(sumo) {
    sumo.command(
      create({
        name: 'build',
        title: 'Build',
        description: 'build it',
        inputSchema: z.object({ target: z.string() }),
        surfaces: ['cli', 'programmatic'],
        /** Implement exec. */ exec() { return ({}); }
      })
    );
    sumo.command(
      create({
        name: 'hidden',
        title: 'Hidden',
        description: 'programmatic only',
        surfaces: ['programmatic'],
        /** Implement exec. */ exec() { return ({}); }
      })
    );
  }
  demo.sumo = { name: 'demo' };
  rt.sumo.use(demo);
  await rt.start();
  try {
    const rows = capabilityRows(rt);
    const build = rows.find(/** Find a matching item. */ (r) => r.command === 'build');
    assert.equal(build.title, 'Build');
    assert.equal(build.plugin, 'demo');
    assert.equal(build.surfaces, 'cli,programmatic');
    assert.equal(build.hasSchema, true);

    // a programmatic-only capability is ABSENT from the CLI listing (surface model)
    assert.equal(rows.some(/** Test whether an item matches. */ (r) => r.command === 'hidden'), false);

    const s = sink();
    await commands({ json: true }, { runtime: rt, out: s.out });
    const listed = JSON.parse(s.text()).commands;
    assert.ok(listed.find(/** Find a matching item. */ (c) => c.command === 'build'), 'build listed');
    assert.equal(listed.some(/** Test whether an item matches. */ (c) => c.command === 'hidden'), false);
  } finally {
    await rt.stop();
  }

  const collisionRt = createRuntime();
  /** Implement shadower. */ function shadower(sumo) {
    // 'list' is a built-in CLI verb; main() routes it to the built-in before dynamic dispatch.
    sumo.command(
      create({ name: 'list', title: 'Shadow List', description: 'collides', /** Implement exec. */ exec() { return 'nope'; } })
    );
  }
  shadower.sumo = { name: 'shadower' };
  collisionRt.sumo.use(shadower);
  await collisionRt.start();
  try {
    assert.ok(BUILTINS.has('list'), 'precondition: list is a built-in');
    // excluded from the reachable listing...
    assert.equal(capabilityRows(collisionRt, BUILTINS).some(/** Test whether an item matches. */ (r) => r.command === 'list'), false);
    // ...and surfaced as a collision
    assert.deepEqual(reservedCliCollisions(collisionRt, BUILTINS), ['list']);

    const s = sink();
    await commands({ json: true }, { runtime: collisionRt, out: s.out });
    const { commands: cmds, diagnostics } = JSON.parse(s.text());
    assert.equal(cmds.some(/** Test whether an item matches. */ (c) => c.command === 'list'), false);
    assert.ok(diagnostics.some(/** Test whether an item matches. */ (d) => d.code === 'SUMO_CLI_NAME_SHADOWED' && d.message.includes('list')));
  } finally {
    await collisionRt.stop();
  }
});
