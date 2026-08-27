import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validatePlugins } from '../src/plugins.mjs';

// Real plugin-declared schemas (spec 06 example) — no fake API.
const githubSchema = z.object({ repo: z.string(), label: z.string().default('sumo:ready') });

test('validatePlugins handles real schema validation, passthrough, and malformed inputs', /** Verify validatePlugins handles real schema validation, passthrough, and malformed inputs. */ () => {
  const valid = validatePlugins({
    use: ['github'],
    plugins: { github: { repo: 'owner/name' } },
    pluginSchemas: { github: githubSchema }
  });
  assert.equal(valid.plugins.github.available, true);
  assert.deepEqual(valid.plugins.github.options, { repo: 'owner/name', label: 'sumo:ready' });
  assert.equal(valid.diagnostics.length, 0);

  const invalid = validatePlugins({
    use: ['github'],
    plugins: { github: { label: 5 } }, // missing repo, wrong label type
    pluginSchemas: { github: githubSchema },
    sources: { github: '/proj/sumo.yml' }
  });
  assert.equal(invalid.plugins.github.available, false);
  assert.ok(invalid.plugins.github.reason.length > 0);
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.diagnostics[0].code, 'SUMO_PLUGIN_CONFIG_INVALID');
  assert.equal(invalid.diagnostics[0].source.plugin, 'github');
  assert.equal(invalid.diagnostics[0].source.file, '/proj/sumo.yml');

  const withoutSource = validatePlugins({
    use: ['github'],
    plugins: { github: null },
    pluginSchemas: { github: z.string() }
  });
  assert.equal(withoutSource.plugins.github.available, false);
  assert.match(withoutSource.plugins.github.reason, /\(root\)/);
  assert.deepEqual(withoutSource.diagnostics[0].source, { plugin: 'github' });

  const passthrough = validatePlugins({
    use: ['mystery'],
    plugins: { mystery: { anything: true } },
    pluginSchemas: {}
  });
  assert.deepEqual(passthrough.plugins.mystery, { available: true, options: { anything: true } });
  assert.equal(passthrough.diagnostics.length, 0);

  const missingSlice = validatePlugins({
    use: ['github'],
    plugins: {},
    pluginSchemas: { github: githubSchema }
  });
  assert.equal(missingSlice.plugins.github.available, false); // repo is required

  const disabled = validatePlugins({
    use: [],
    plugins: { github: { repo: 'x' } },
    pluginSchemas: { github: githubSchema }
  });
  assert.deepEqual(disabled.plugins, {});

  const malformed = validatePlugins({
    use: 'github',
    plugins: [],
    pluginSchemas: { github: githubSchema }
  });
  assert.deepEqual(malformed.plugins, {});
  assert.deepEqual(malformed.diagnostics, []);
});
