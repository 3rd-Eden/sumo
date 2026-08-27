#!/usr/bin/env node
/** Verify that the public source tree and npm artifact contain no private provenance or dev files. */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGAL_NOTICE = 'THIRD_PARTY_NOTICES.md';
/**
 * Join fragments so the audit rules do not contain the forbidden literals they detect.
 *
 * @access private
 * @param {string[]} values - Literal fragments to join.
 * @returns {string} The joined literal.
 */
const parts = (...values) => values.join('');

const forbidden = [
  ['corporate provenance', parts('go', 'daddy')],
  ['corporate provenance', parts('gd', 'corp')],
  ['private package scope', parts('@guard', 'rails')],
  ['prior-project provenance', parts('way', 'post')],
  ['prior-project provenance', parts('lore', 'li')],
  ['prior-project provenance', parts('@ben', 'to')],
  ['prior-project provenance', parts('shrub', 'bery')],
  ['prior-project provenance', parts('mcp', '-layer')],
  ['prior-project provenance', parts('her', 'mes')],
  ['prior-project provenance', parts('Nous', 'Research')],
  ['prior-project provenance', parts('signal', 'ary')],
  ['prior-project provenance', parts('code', 'broker')],
  ['prior-project provenance', parts('storage', '-engine')],
  ['prior-project provenance', parts('big', 'pipe')],
  ['prior-project provenance', parts('gas', 'ket')],
  ['private test repository', parts('sumo', '-e2e')],
  ['personal filesystem path', parts('/Users', '/')],
  ['captured workspace path', parts('/work', '/sumo')],
  ['historical attribution', parts('direct', ' port')],
  ['historical attribution', parts('prior internal', ' project')],
  ['historical decision record', parts('Evidence', ' status')],
  ['historical decision record', parts('NEEDS', '-HUMAN')],
  ['historical decision record', parts('decision', ' register')],
  ['historical decision record', parts('gap', ' register')],
  ['historical decision record', parts('Maps to ', '00c gaps')],
  ['private fixture attribution', parts('maintainer', "'s captured")]
].map(([label, value]) => ({ label, expression: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig') }));
forbidden.push({ label: 'historical attribution', expression: new RegExp('\\b' + parts('ported', ' from') + '\\b', 'ig') });
forbidden.push({ label: 'historical decision id', expression: new RegExp('\\b(?:G-F\\d+|[SVJCR]-\\d+|AR\\d+)\\b', 'g') });

const privateOwner = new RegExp(parts('3rd', '-Eden') + '\\/([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)', 'ig');
const forbiddenPackPaths = [
  /^(?:\.agents|\.codex|\.cursor|\.github|journeys|scripts|spike)\//,
  /^docs\/specs\//,
  /(?:^|\/)fixtures\//,
  /(?:^|\/)test\//,
  /\.test\.(?:mjs|js)$/,
  /\.serial\.mjs$/
];

/**
 * Scan text entries for release-blocking provenance.
 *
 * @access public
 * @param {Array<{ path: string, content: string }>} entries - Repository or fixture text entries to inspect.
 * @returns {Array<{ path: string, reason: string, match: string }>} Provenance findings grouped by path and rule.
 */
export function auditEntries(entries) {
  const findings = [];
  for (const entry of entries) {
    if (entry.path === LEGAL_NOTICE) continue;
    for (const { label, expression } of forbidden) {
      expression.lastIndex = 0;
      for (const match of entry.content.matchAll(expression)) findings.push({ path: entry.path, reason: label, match: match[0] });
    }
    privateOwner.lastIndex = 0;
    for (const match of entry.content.matchAll(privateOwner)) {
      if (!['sumo', 'sumo.git'].includes(match[1].toLowerCase())) findings.push({ path: entry.path, reason: 'noncanonical project repository', match: match[0] });
    }
  }
  return findings;
}

/**
 * Validate the file list produced by npm pack.
 *
 * @access public
 * @param {string[]} files - Relative paths in the npm artifact.
 * @param {{ required?: string[] }} options - Required runtime files that must be present.
 * @returns {Array<{ path: string, reason: string, match: string }>} Packaging boundary findings.
 */
export function auditPackFiles(files, { required = [] } = {}) {
  const findings = [];
  for (const file of files) {
    if (forbiddenPackPaths.some((expression) => expression.test(file))) findings.push({ path: file, reason: 'development-only file in package', match: file });
  }
  for (const file of required) {
    if (!files.includes(file)) findings.push({ path: file, reason: 'required runtime file missing from package', match: file });
  }
  return findings;
}

/**
 * Read text files visible in the current repository without following deleted tracked paths.
 *
 * @access private
 * @returns {Array<{ path: string, content: string }>} Repository text entries eligible for scanning.
 */
function repositoryEntries() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT });
  return output.toString('utf8').split('\0').filter(Boolean).flatMap((relative) => readTextEntry(relative, path.join(ROOT, relative)));
}

/**
 * Return one text entry when a repository path is a readable regular file.
 *
 * @access public
 * @param {string} relative - Repository-relative path recorded in the audit output.
 * @param {string} file - Absolute filesystem path to inspect.
 * @returns {Array<{ path: string, content: string }>} One eligible text entry, or no entry for non-files and binary data.
 */
export function readTextEntry(relative, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  const content = fs.readFileSync(file);
  return content.includes(0) ? [] : [{ path: relative, content: content.toString('utf8') }];
}

/**
 * Ask npm for the exact dry-run artifact file list.
 *
 * @access private
 * @returns {string[]} Relative paths npm would include in the package.
 */
function packedFiles() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  const report = /** @type {Array<{ files: Array<{ path: string }> }>} */ (JSON.parse(output));
  return report[0].files.map((entry) => entry.path);
}

/**
 * Derive the runtime files every declared public entry point and bundled asset requires.
 *
 * @access private
 * @returns {string[]} Required relative package paths.
 */
function requiredRuntimeFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return [
    'package.json',
    'README.md',
    'LICENSE',
    LEGAL_NOTICE,
    manifest.bin.sumo.replace(/^\.\//, ''),
    ...Object.values(manifest.exports).map((target) => target.replace(/^\.\//, '')),
    'packages/mcp/instructions.md',
    'plugins/opportunist/prompts/repair.md',
    'plugins/opportunist/prompts/triage.md',
    'plugins/roundtable/skills/announce.md',
    'plugins/campsite-rule/package.json',
    'plugins/campsite-rule/SKILL.md',
    'plugins/campsite-rule/hooks.json',
    'skills/sumo/SKILL.md'
  ];
}

/**
 * Run the repository and packed-artifact release audit.
 *
 * @access public
 * @returns {number} Process-style status code: zero when the release boundary is clean.
 */
export function main() {
  const findings = [
    ...auditEntries(repositoryEntries()),
    ...auditPackFiles(packedFiles(), { required: requiredRuntimeFiles() })
  ];
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.path}: ${finding.reason}: ${finding.match}\n`);
    return 1;
  }
  process.stdout.write('release audit passed\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
