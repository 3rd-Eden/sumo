/**
 * Module-level import guard for campsite-rule internals.
 *
 * Prevents agents from importing the engine, ledger, or barrel directly
 * by checking whether the Node.js entry script is the authorized hook
 * adapter.  Vitest is allowlisted so tests continue to work.
 *
 * The guard fires at import time — before any code in the importing
 * module can execute — by running as a bare top-level statement in
 * each guarded file.
 *
 * Known bypasses (defense-in-depth via command blocking and nonce):
 *   - Dynamic `import()` after spoofing `process.argv[1]`
 *   - `VITEST=true` env var spoofing (caught by command-blocking hooks)
 *   - Wrapper scripts named `hook.js` (caught by command-blocking hooks)
 *
 * @module guard
 */

const entry = process.argv[1] ?? '';
const publicImport = Symbol.for('sumo.campsite.public-import');

const allowed = entry.endsWith('/bin/hook.js') || process.env.VITEST !== undefined || globalThis[publicImport] === true;

if (!allowed) {
  throw new Error(
    'campsite-rule: direct import denied.\n' +
      'Read .agents/skills/campsite-rule/SKILL.md and follow the resolve workflow.\n' +
      'Resolve findings via: echo \'{"findingId":"...","classification":"...","evidence":"..."}\'' +
      ' | node .agents/skills/campsite-rule/bin/hook.js --repo . resolve'
  );
}
