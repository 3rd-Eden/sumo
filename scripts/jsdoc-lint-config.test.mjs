import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const ESLINT = path.resolve('node_modules/.bin/eslint');
const CONFIG = path.resolve('eslint.config.mjs');

/**
 * Run ESLint against a temporary module.
 * @access private
 * @param {string} source - Module source text to lint.
 * @returns {Promise<{ code: number, output: string }>} ESLint exit code and combined output.
 */
async function lintSource(source) {
  const dir = await fs.mkdtemp(path.resolve('scripts/.jsdoc-lint-fixture-'));
  const file = path.join(dir, 'fixture.mjs');
  await fs.writeFile(file, source);

  try {
    await execFileAsync(ESLINT, ['--config', CONFIG, file], { cwd: process.cwd() });
    return { code: 0, output: '' };
  } catch (err) {
    return {
      code: err.code ?? 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('JSDoc lint rejects bare comments and missing contract tags', async () => {
  const result = await lintSource(`
    /**
     * Parse a value.
     */
    export function parseValue(value) {
      return String(value);
    }
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /Missing JSDoc @param/);
  assert.match(result.output, /Missing JSDoc @returns/);
  assert.match(result.output, /Missing required tag "access"/);
});

test('JSDoc lint rejects classes without class and access tags', async () => {
  const result = await lintSource(`
    /**
     * Shared parser.
     */
    export class Parser {
      /**
       * Create a parser.
       * @access public
       */
      constructor() {}
    }
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /Missing required tag "class"/);
  assert.match(result.output, /Missing required tag "access"/);
});

test('JSDoc lint rejects generated boilerplate descriptions', async () => {
  const result = await lintSource(`
    /**
     * Parse a value.
     * @access public
     * @param {unknown} value - Parameter value.
     * @returns {string} Value returned by \`parseValue\`.
     */
    export function parseValue(value) {
      return String(value);
    }
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /not generated boilerplate/);
});

test('JSDoc lint rejects any types', async () => {
  const result = await lintSource(`
    /**
     * Parse a value.
     * @access public
     * @param {any} value - Value to stringify.
     * @returns {any} String representation of the value.
     */
    export function parseValue(value) {
      return String(value);
    }
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /Prefer a more specific type to `any`/);
});

test('JSDoc lint accepts complete function and class contracts', async () => {
  const result = await lintSource(`
    /**
     * Shared parser.
     * @access public
     * @class
     */
    export class Parser {
      /**
       * Create a parser.
       * @access public
       */
      constructor() {}
    }

    /**
     * Parse a value.
     * @access public
     * @param {unknown} value - Value to stringify.
     * @returns {string} String representation of the value.
     */
    export function parseValue(value) {
      return String(value);
    }
  `);

  assert.equal(result.code, 0, result.output);
});
