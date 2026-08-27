import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditEntries, auditPackFiles } from './release-audit.mjs';

test('auditEntries rejects internal provenance and noncanonical project repositories', () => {
  const corporate = ['gd', 'corp'].join('');
  const otherRepo = ['3rd-Eden', 'example'].join('/');
  const historical = ['prior internal', ' project'].join('');
  const findings = auditEntries([
    { path: 'docs/example.md', content: `See ${corporate} tooling and https://github.com/${otherRepo}.` },
    { path: 'src/example.mjs', content: `Derived from a ${historical}.` },
    { path: 'docs/spec.md', content: ['NEEDS', '-HUMAN: choose later'].join('') }
  ]);

  assert.ok(findings.some((finding) => finding.path === 'docs/example.md' && finding.match.toLowerCase() === corporate));
  assert.ok(findings.some((finding) => finding.path === 'docs/example.md' && finding.match === otherRepo));
  assert.ok(findings.some((finding) => finding.path === 'src/example.mjs' && finding.match === historical));
  assert.ok(findings.some((finding) => finding.path === 'docs/spec.md' && finding.reason === 'historical decision record'));
});

test('auditEntries permits the canonical repository, generic examples, and legal notices', () => {
  assert.deepEqual(auditEntries([
    { path: 'README.md', content: 'https://github.com/3rd-Eden/sumo and owner/repo' },
    { path: 'package.json', content: 'git+https://github.com/3rd-Eden/sumo.git' },
    { path: 'THIRD_PARTY_NOTICES.md', content: 'Copyright notices may name upstream projects and authors.' }
  ]), []);
});

test('auditPackFiles rejects development files and accepts required runtime files', () => {
  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'src/index.mjs',
    'src/version.mjs',
    'plugins/campsite-rule/src/index.js',
    'plugins/campsite-rule/bin/hook.js'
  ];

  assert.deepEqual(auditPackFiles(required, { required }), []);
  const findings = auditPackFiles([...required, 'docs/specs/03-plugin-runtime.md', 'packages/db/test/client.test.mjs'], { required });
  assert.ok(findings.some((finding) => finding.path === 'docs/specs/03-plugin-runtime.md'));
  assert.ok(findings.some((finding) => finding.path === 'packages/db/test/client.test.mjs'));
});
