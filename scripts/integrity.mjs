#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SEARCH_ROOTS = ['packages', 'plugins', 'src'].filter((p) => fs.existsSync(path.join(ROOT, p)));
const AST_GREP_BIN = path.join(path.dirname(fileURLToPath(import.meta.resolve('@ast-grep/cli/package.json'))), process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');

const integrityFiles = execFileSync('rg', ['--files', ...SEARCH_ROOTS], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.test.mjs') || file.endsWith('.test.js') || file.endsWith('.serial.mjs') || /\/test\/.*\.(?:mjs|js)$/.test(file));

/** @type {Array<{file: string, line: number, message: string, sample: string}>} */
const findings = [];

/**
 * Record one integrity finding for the final failure report.
 *
 * @access private
 * @param {string} file - File containing the forbidden test pattern.
 * @param {number} line - Zero-based line number where the finding starts.
 * @param {string} message - Human-readable explanation of the violation.
 * @param {string} sample - Offending source excerpt.
 * @returns {void} Appends the finding to the in-memory report.
 */
function add(file, line, message, sample) {
  findings.push({ file, line, message, sample: String(sample ?? '').trim().split('\n')[0] });
}

/**
 * Run one AST-grep rule over the repository and record every matching test violation.
 *
 * @access private
 * @param {string} pattern - AST-grep pattern used to find forbidden constructs.
 * @param {string} message - Integrity error reported for each match.
 * @returns {void} Adds one finding per matching source location.
 */
function ast(pattern, message) {
  const run = spawnSync(AST_GREP_BIN, ['--pattern', pattern, '--lang', 'javascript', ...SEARCH_ROOTS, '--json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  });
  if (run.error || (run.status !== 0 && !run.stdout?.trim().startsWith('['))) {
    throw run.error ?? new Error(`ast-grep failed for pattern ${pattern}`);
  }
  for (const match of JSON.parse(run.stdout || '[]')) {
    if (!integrityFiles.includes(match.file)) continue;
    add(match.file, match.range.start.line, message, match.text);
  }
}

ast('mock.$METHOD($$$)', 'node:test mock API bypasses real Sumo behavior');
ast("import { mock } from 'node:test'", 'node:test mock import is forbidden');
ast('$REG.harness($NAME, ($CTX) => ({ $$$ }))', 'harness registration returns an object-literal test substitute');
ast('$REG.harness($NAME, function ($CTX) { return { $$$ } })', 'harness registration returns an object-literal test substitute');
ast('$REG.messenger($NAME, ($CTX) => ({ $$$ }))', 'messenger registration returns an object-literal test substitute');
ast('$REG.messenger($NAME, function ($CTX) { return { $$$ } })', 'messenger registration returns an object-literal test substitute');

const textRules = [
  { re: /\bfakeSpawn\b/, message: 'fakeSpawn-style process substitute is forbidden' }, { re: /\bclass\s+Fake[A-Za-z0-9_]*\b/, message: 'Fake* test class is forbidden' }, { re: /\bclass\s+[A-Za-z0-9_]+\s+extends\s+(?:Harness|Messenger|HttpMessenger)\b/, message: 'in-test harness/messenger subclass is forbidden; use a shipped adapter/reference implementation' }, { re: /\._[A-Za-z0-9_]+\s*\(/, message: 'private underscore API access in tests bypasses production surfaces' }, { re: /\basync\s+steer\s*\(/, message: 'inline steer callback in tests bypasses daemon-hosted steering; use a real daemon/client path' }, { re: /\basync\s+observe\s*\(/, message: 'inline observe callback in tests bypasses hook ingestion; use a real daemon/client path' }, { re: /\bspawnFn\s*:/, message: 'spawnFn injection in tests bypasses the real child_process path' }, { re: /\bwrapRun\s*\([\s\S]{0,500}\bvalue\s*:\s*\{/, message: 'wrapRun test returns a handcrafted session-like value' }, { re: /\btest-only\b.*\b(?:deep import|internal|private)\b/i, message: 'test-only internal/deep-import bypass is forbidden; use a public package export' }
];

for (const file of integrityFiles) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const { re, message } of textRules) {
    const match = re.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length - 1;
    add(file, line, message, match[0]);
  }
}

if (findings.length) {
  console.error('Forbidden test substitute patterns found:\n');
  for (const f of findings) console.error(`${f.file}:${f.line + 1} ${f.message}\n  ${f.sample}`);
  process.exit(1);
}

console.log(`test-integrity: ${integrityFiles.length} test files/support files scanned; no forbidden test substitutes found`);
