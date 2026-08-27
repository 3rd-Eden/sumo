/**
 * Configuration discovery and defaults for the campsite engine.
 *
 * Walks ancestor `package.json` files from the repository root upward
 * looking for a `"campsite"` key.  When found, the user-provided values
 * are deep-merged over the built-in defaults.  When absent, all defaults
 * apply — zero config is the default experience.
 *
 * @module config
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Return the full default configuration.
 *
 * Every value matches the original hardcoded behavior so that existing
 * installations with no `"campsite"` key in `package.json` continue to
 * work identically.
 *
 * @returns {object} Frozen default config.
 */
export function defaults() {
  return {
    detection: {
      phrases: [
        'pre-existing',
        'pre existing',
        'not related to',
        'not related to our',
        'not related to my',
        'an unrelated',
        'is unrelated',
        'unrelated to our',
        'unrelated to my',
        'separate concern',
        'separate issue',
        'out of scope',
        'not my task',
        'not part of this',
        'not part of my',
        'was not modified',
        'were not modified',
        'was not changed',
        'did not modify',
        'someone else owns',
        'i will mention it later',
        'mention it in the final',
        'mention it later'
      ],
      metaTokens: ['campsite'],
      metaTokenThreshold: 1,
      snippetRadius: 120,
      metaParagraphFallback: 120,
      backtickScanRadius: 200,
      quoteLookaround: 4
    },
    snapshot: {
      contextRadius: 500,
      paragraphDelimiter: '\n\n'
    },
    ledger: {
      baseDir: join(homedir(), '.local', 'share', 'campsite'),
      fileName: 'ledger.json'
    },
    state: {
      directory: null,
      filePrefix: 'campsite-'
    },
    verification: {
      patterns: ['bin/onboard\\s+(up|test|build|lint)\\b', '\\bpnpm run test:skills\\b'],
      successExitCodes: [0],
      ignoredFailureTypes: ['permission_denied']
    },
    resolve: {
      classifications: ['fixed', 'triaged', 'false-positive', 'bypassed'],
      subjects: ['policy-docs', 'verification', 'implementation'],
      minEvidenceLength: 12,
      evidencePatterns: {
        generic: [
          '(?:^|\\b)[a-f0-9]{7,40}(?:\\b|$)',
          '(?:^|\\s)(?:(?:\\/|\\.{1,2}\\/)(?:[^/\\n]+\\/)*[^/\\n]+|(?:[^\\s/]+\\/)*[^\\s/]+)\\.[A-Za-z0-9]+',
          'https?://\\S+',
          '#\\d+',
          '\\b\\w*(?:test|spec)\\w*\\b'
        ],
        fixed: [
          '(?:^|\\b)[a-f0-9]{7,40}(?:\\b|$)',
          '(?:^|\\s)(?:(?:\\/|\\.{1,2}\\/)(?:[^/\\n]+\\/)*[^/\\n]+|(?:[^\\s/]+\\/)*[^\\s/]+)\\.[A-Za-z0-9]+',
          'https?://\\S+'
        ],
        falsePositive: [
          '\\bquoted\\b',
          '\\bfenced\\b',
          '\\bbacktick\\b',
          'code block',
          '\\bcampsite\\b',
          '\\bmeta\\b',
          '\\bdetection\\b'
        ],
        bypassed: [
          '\\boutage\\b',
          '\\btimeout\\b',
          '\\bunreachable\\b',
          '\\bdisruption\\b',
          '\\bdown\\b',
          '\\bunavailable\\b',
          '\\bexternal\\b'
        ]
      },
      maxIdenticalEvidence: null,
      minModelLength: 3,
      requireModel: false,
      requireEffort: false,
      verifyArtifacts: true,
      escalationThresholds: [2, 3]
    },
    format: {
      stopIntro: 'Campsite hook flagged {count} concrete issue{s} to resolve before completion.',
      skillPath: '.agents/skills/campsite-rule/SKILL.md',
      resolveCli: 'node .agents/skills/campsite-rule/bin/hook.js --repo . resolve',
      sourceLabels: {
        thought: 'agent thought',
        response: 'agent response'
      }
    }
  };
}

/**
 * Walk ancestor directories from `root` upward looking for a
 * `package.json` that contains a `"campsite"` key.
 *
 * Returns the raw user config object, or `null` when none is found.
 * Stops at the filesystem root to avoid infinite loops.
 *
 * @param {string} root - Starting directory (typically the repo root).
 * @returns {object|null} The `"campsite"` value, or null.
 */
export function load(root) {
  let dir = pathResolve(root);

  while (true) {
    try {
      const text = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(text);

      if (pkg.campsite) return pkg.campsite;
    } catch {
      /* no package.json here, keep walking */
    }

    const parent = dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Resolve the final configuration for a repository.
 *
 * Loads user config from the nearest ancestor `package.json`, deep-merges
 * it over the defaults, expands tildes in path values, and freezes the
 * result.
 *
 * @param {string} [root] - Repository root.  Defaults to `process.cwd()`.
 * @returns {object} Frozen merged config.
 */
export function resolve(root) {
  const base = defaults();
  const user = load(root ?? process.cwd());

  if (!user) return freeze(base);

  return freeze(merge(base, user));
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Deep-merge `source` into `target`, returning a new object.
 *
 * Arrays in `source` replace (not concatenate) arrays in `target` so
 * that a user can fully override the phrase list without appending to it.
 *
 * @param {object} target - Default config.
 * @param {object} source - User overrides.
 * @returns {object} Merged result.
 */
function merge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const t = target[key];
    const s = source[key];

    if (Array.isArray(s)) {
      result[key] = [...s];
    } else if (s && typeof s === 'object' && t && typeof t === 'object' && !Array.isArray(t)) {
      result[key] = merge(t, s);
    } else if (s !== undefined) {
      result[key] = s;
    }
  }

  return result;
}

/**
 * Expand `~` prefixes in path values and deep-freeze the config.
 *
 * @param {object} config - Merged config object.
 * @returns {object} Frozen config with expanded paths.
 */
function freeze(config) {
  if (config.ledger?.baseDir) {
    config.ledger.baseDir = expand(config.ledger.baseDir);
  }

  if (config.state?.directory) {
    config.state.directory = expand(config.state.directory);
  }

  return Object.freeze(deep(config));
}

/**
 * Recursively freeze an object and all nested objects/arrays.
 *
 * @param {object} obj - Target object.
 * @returns {object} The same object, now frozen at every level.
 */
function deep(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      deep(value);
    }
  }

  return Object.freeze(obj);
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * @param {string} path - File path, possibly starting with `~`.
 * @returns {string} Expanded path.
 */
function expand(path) {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  if (path === '~') {
    return homedir();
  }

  return path;
}
