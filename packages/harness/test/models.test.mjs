import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Claude, Codex, Copilot, Cursor } from '../src/index.mjs';
import { models as claudeModels } from '../src/adapters/claude-code.mjs';
import { models as codexModels } from '../src/adapters/codex.mjs';
import { models as copilotModels } from '../src/adapters/copilot.mjs';
import { models as cursorModels } from '../src/adapters/cursor.mjs';
import { list, model, pick, rank, resolve } from '../src/models.mjs';

const NOPE = '/nonexistent/sumo-model-test-bin';

/**
 * Assert the public model-list shape returned by a harness.
 *
 * @param {{ status?: string, models?: unknown[], reason?: string }} out - List result.
 */
function assertList(out) {
  assert.ok(out && typeof out === 'object', 'list() returns an object');
  assert.ok(out.status === 'available' || out.status === 'unavailable', 'status is explicit');
  assert.ok(Array.isArray(out.models), 'models is an array');
  if (out.status === 'available') {
    assert.ok(out.models.length > 0, 'available lists include models');
    for (const model of out.models) {
      assert.ok(model && typeof model === 'object', 'model row is an object');
      assert.equal(typeof /** @type {{ id?: unknown }} */ (model).id, 'string', 'model row has an id');
      assert.ok(/** @type {{ id: string }} */ (model).id.length > 0, 'model id is non-empty');
    }
  } else {
    assert.equal(typeof out.reason, 'string', 'unavailable lists include a reason');
  }
}

/**
 * Run one harness's real model list path.
 *
 * @param {import('node:test').TestContext} t - Test context.
 * @param {string} id - Harness id for diagnostics.
 * @param {{ list: () => Promise<{ status: string, models: unknown[], reason?: string }> }} harness - Harness adapter.
 * @returns {Promise<{ status: string, models: unknown[], reason?: string }|null>} Available list result.
 */
async function listed(t, id, harness) {
  const out = await harness.list();
  assertList(out);
  if (out.status !== 'available') {
    t.skip(`${id} model list unavailable: ${out.reason}`);
    return null;
  }
  return out;
}

test('codex list() returns real models and derives distinct tiers', { timeout: 30_000 }, /** Verify codex list() returns real models and derives distinct tiers. */ async (t) => {
  const out = await listed(t, 'codex', new Codex());
  if (!out) return;
  const tiers = pick(out.models);
  assert.deepEqual(tiers, {
    fast: 'gpt-5.4-mini',
    balanced: 'gpt-5.4',
    powerful: 'gpt-5.5'
  });
  assert.equal(new Set(Object.values(tiers)).size, 3, 'tier picks are distinct');
  assert.deepEqual(await resolve('fast', new Codex()), {
    ok: true,
    model: 'gpt-5.4-mini',
    tier: 'fast',
    requested: 'fast'
  });
});

test('shared picker ranks future model rows without hardcoded ids', /** Verify shared picker ranks future model rows without hardcoded ids. */ () => {
  const tiers = pick([
    {
      id: 'gpt-5.5',
      description: 'Strong model for everyday coding.'
    },
    {
      id: 'gpt-5.6',
      description: 'Frontier model for complex coding.'
    },
    {
      id: 'gpt-5.6-mini',
      description: 'Small, fast, and cost-efficient model.'
    }
  ]);
  assert.deepEqual(tiers, {
    fast: 'gpt-5.6-mini',
    balanced: 'gpt-5.5',
    powerful: 'gpt-5.6'
  });

  const rows = rank([
    {
      id: 'vendor-4.8-lite',
      name: 'Vendor 4.8 Lite'
    },
    {
      id: 'vendor-4.8-standard',
      name: 'Vendor 4.8 Standard'
    },
    {
      id: 'vendor-4.8-pro',
      name: 'Vendor 4.8 Pro'
    }
  ]);
  assert.ok(rows.find((row) => row.id === 'vendor-4.8-lite')?.speed > rows.find((row) => row.id === 'vendor-4.8-pro')?.speed);
  assert.ok(rows.find((row) => row.id === 'vendor-4.8-pro')?.power > rows.find((row) => row.id === 'vendor-4.8-lite')?.power);
});

test('shared picker never fabricates duplicate tiers from undersized lists', /** Verify shared picker never fabricates duplicate tiers from undersized lists. */ () => {
  assert.deepEqual(pick([]), {});
  assert.deepEqual(pick([
    {
      id: 'gpt-5.5'
    },
    {
      id: 'gpt-5.4-mini'
    }
  ]), {
    fast: 'gpt-5.4-mini',
    powerful: 'gpt-5.5'
  });
});

test('shared model normalization accepts native id shapes and rejects invalid rows', /** Verify shared model normalization accepts native id shapes and rejects invalid rows. */ () => {
  assert.equal(model(null), null);
  assert.equal(model({}), null);
  assert.deepEqual(model({
    modelId: 'vendor-frontier-4.8-pro',
    displayName: 'Vendor Frontier 4.8 Pro',
    description: 'Advanced research model',
    provider: 'vendor',
    priority: 7
  }), {
    id: 'vendor-frontier-4.8-pro',
    name: 'Vendor Frontier 4.8 Pro',
    description: 'Advanced research model',
    provider: 'vendor',
    version: 40_800,
    priority: 7,
    raw: {
      modelId: 'vendor-frontier-4.8-pro',
      displayName: 'Vendor Frontier 4.8 Pro',
      description: 'Advanced research model',
      provider: 'vendor',
      priority: 7
    }
  });
  assert.equal(model({ id: 'vendor-5.6.1-mini' })?.version, 50_601);
});

test('shared list() normalizes adapter list outcomes', /** Verify shared list() normalizes adapter list outcomes. */ async () => {
  assert.deepEqual(await list({
    id: 'plain'
  }), {
    status: 'unavailable',
    models: [],
    reason: 'plain does not expose list()'
  });
  assert.deepEqual(await list({
    id: 'empty',
    /** List no native models. */
    list() {
      return null;
    }
  }), {
    status: 'unavailable',
    models: [],
    reason: 'empty returned no models'
  });
  assert.deepEqual(await list({
    id: 'down',
    /** List unavailable native models. */
    list() {
      return {
        status: 'unavailable',
        models: [
          {
            slug: 'gpt-5.5'
          }
        ]
      };
    }
  }), {
    status: 'unavailable',
    models: [
      {
        id: 'gpt-5.5',
        version: 50_500,
        raw: {
          slug: 'gpt-5.5'
        }
      }
    ],
    reason: 'models unavailable'
  });
  assert.deepEqual(await list({
    id: 'throwing',
    /** List throws like a failed native command. */
    list() {
      throw new Error('native command failed');
    }
  }), {
    status: 'unavailable',
    models: [],
    reason: 'native command failed'
  });
});

test('shared resolve handles exact ids, missing tiers, and unavailable lists', /** Verify shared resolve handles exact ids, missing tiers, and unavailable lists. */ async () => {
  assert.deepEqual(await resolve(undefined, {
    id: 'codex'
  }), {
    ok: true
  });
  assert.deepEqual(await resolve('gpt-5.4-mini', {
    id: 'codex',
    /** Should not list exact model ids. */
    list() {
      throw new Error('should not list exact ids');
    }
  }), {
    ok: true,
    model: 'gpt-5.4-mini'
  });
  assert.deepEqual(await resolve('balanced', {
    id: 'tiny',
    /** List too few native models. */
    list() {
      return {
        status: 'available',
        models: [
          {
            id: 'gpt-5.5'
          },
          {
            id: 'gpt-5.4-mini'
          }
        ]
      };
    }
  }), {
    ok: false,
    code: 'SUMO_MODEL_NOT_FOUND',
    reason: "tiny cannot assign 'balanced' from 2 model(s)"
  });
  assert.deepEqual(await resolve('fast', {
    id: 'offline',
    /** List unavailable native models. */
    list() {
      return {
        status: 'unavailable',
        models: [],
        reason: 'not logged in'
      };
    }
  }), {
    ok: false,
    code: 'SUMO_MODEL_NOT_FOUND',
    reason: 'offline models unavailable: not logged in'
  });
  assert.deepEqual(await resolve('fast', {
    /** List unavailable native models. */
    list() {
      return {
        status: 'available',
        models: []
      };
    }
  }), {
    ok: false,
    code: 'SUMO_MODEL_NOT_FOUND',
    reason: 'harness models unavailable: no models available'
  });
  assert.deepEqual(await resolve('balanced', {
    /** List too few native models. */
    list() {
      return {
        status: 'available',
        models: [
          {
            id: 'model-a'
          },
          {
            id: 'model-b'
          }
        ]
      };
    }
  }), {
    ok: false,
    code: 'SUMO_MODEL_NOT_FOUND',
    reason: "harness cannot assign 'balanced' from 2 model(s)"
  });
});

test('adapter parsers normalize captured native model-list shapes', /** Verify adapter parsers normalize captured native model-list shapes. */ () => {
  assert.deepEqual(codexModels({
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'Frontier model for complex coding, research, and real-world work.',
        visibility: 'list',
        priority: 7
      },
      {
        slug: 'gpt-5.4-mini',
        display_name: 'GPT-5.4-Mini',
        description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
        visibility: 'list',
        priority: 23
      },
      {
        slug: 'codex-auto-review',
        display_name: 'Codex Auto Review',
        visibility: 'hide',
        priority: 43
      }
    ]
  }), [
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      priority: 7,
      raw: {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'Frontier model for complex coding, research, and real-world work.',
        visibility: 'list',
        priority: 7
      }
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4-Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      priority: 23,
      raw: {
        slug: 'gpt-5.4-mini',
        display_name: 'GPT-5.4-Mini',
        description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
        visibility: 'list',
        priority: 23
      }
    }
  ]);

  assert.deepEqual(cursorModels('\u001b[2K\u001b[GLoading models...\n\u001b[2K\u001b[1A\u001b[2K\u001b[GNo models available for this account.'), []);
  assert.deepEqual(cursorModels('› 1. gpt-5.5  Frontier\n  2. gpt-5.4-mini  Fast'), [
    {
      id: 'gpt-5.5',
      raw: {
        line: 'gpt-5.5'
      }
    },
    {
      id: 'gpt-5.4-mini',
      raw: {
        line: 'gpt-5.4-mini'
      }
    }
  ]);

  assert.deepEqual(copilotModels([
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      modelPickerCategory: 'versatile'
    },
    {
      name: 'Missing id'
    }
  ]), [
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      description: 'versatile',
      raw: {
        id: 'claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        modelPickerCategory: 'versatile'
      }
    }
  ]);

  assert.deepEqual(claudeModels({
    data: [
      {
        id: 'claude-opus-4-8',
        display_name: 'Claude Opus 4.8'
      },
      {
        display_name: 'Missing id'
      }
    ]
  }), [
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      raw: {
        id: 'claude-opus-4-8',
        display_name: 'Claude Opus 4.8'
      }
    }
  ]);
});

test('adapter parsers reject malformed native model-list rows', /** Verify adapter parsers reject malformed native model-list rows. */ () => {
  assert.deepEqual(codexModels(JSON.stringify({
    models: [
      null,
      {},
      {
        slug: ''
      },
      {
        slug: 'hidden',
        visibility: 'hide'
      },
      {
        slug: 'gpt-5.4',
        displayName: 'ignored'
      }
    ]
  })), [
    {
      id: 'gpt-5.4',
      raw: {
        slug: 'gpt-5.4',
        displayName: 'ignored'
      }
    }
  ]);
  assert.deepEqual(codexModels({}), []);
  assert.deepEqual(cursorModels('Loading models...\n* claude-sonnet-4.6 - Balanced\nbad model id with spaces'), [
    {
      id: 'claude-sonnet-4.6',
      raw: {
        line: 'claude-sonnet-4.6'
      }
    }
  ]);
  assert.deepEqual(copilotModels([
    null,
    {},
    {
      id: 'auto'
    }
  ]), [
    {
      id: 'auto',
      raw: {
        id: 'auto'
      }
    }
  ]);
  assert.deepEqual(claudeModels(null), []);
  assert.deepEqual(claudeModels({
    data: [
      null,
      {},
      {
        id: 'claude-opus-4-6'
      }
    ]
  }), [
    {
      id: 'claude-opus-4-6',
      raw: {
        id: 'claude-opus-4-6'
      }
    }
  ]);
});

test('adapter list() reports unavailable native model commands honestly', /** Verify adapter list() reports unavailable native model commands honestly. */ async () => {
  const codex = await new Codex({
    config: {
      bin: NOPE
    }
  }).list();
  assert.equal(codex.status, 'unavailable');
  assert.match(codex.reason, /nonexistent\/sumo-model-test-bin|ENOENT|codex debug models exited 1/);

  const cursor = await new Cursor({
    config: {
      bin: 'cursor'
    }
  }).list();
  assert.equal(cursor.status, 'unavailable');
  assert.match(cursor.reason, /desktop launcher/);

  const copilot = await new Copilot({
    config: {
      bin: NOPE
    }
  }).list();
  assert.equal(copilot.status, 'unavailable');
  assert.match(copilot.reason, /not found|ENOENT|no such file/i);

  const claude = await new Claude({
    config: {
      bin: NOPE
    }
  }).list();
  assert.equal(claude.status, 'unavailable');
  assert.match(claude.reason, /not found|ENOENT|no such file/i);
});

test('cursor list() returns the expected model-list shape', { timeout: 30_000 }, /** Verify cursor list() returns the expected model-list shape. */ async (t) => {
  const out = await listed(t, 'cursor', new Cursor());
  if (!out) return;
  const tiers = pick(out.models);
  assert.equal(new Set(Object.values(tiers)).size, Object.values(tiers).length, 'tier picks are distinct');
});

test('copilot list() returns the expected model-list shape', { timeout: 30_000 }, /** Verify copilot list() returns the expected model-list shape. */ async (t) => {
  const out = await listed(t, 'copilot', new Copilot());
  if (!out) return;
  const tiers = pick(out.models);
  assert.equal(new Set(Object.values(tiers)).size, Object.values(tiers).length, 'tier picks are distinct');
});

test('claude-code list() returns the expected model-list shape', { timeout: 30_000 }, /** Verify claude-code list() returns the expected model-list shape. */ async (t) => {
  const out = await listed(t, 'claude-code', new Claude());
  if (!out) return;
  const tiers = pick(out.models);
  assert.equal(new Set(Object.values(tiers)).size, Object.values(tiers).length, 'tier picks are distinct');
});
