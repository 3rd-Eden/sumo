#!/usr/bin/env node
/**
 * @module sumo/cli/cli
 * The `sumo` bin entrypoint: parse argv, dispatch, map the handler's return to a process exit code.
 */

import { fileURLToPath } from 'node:url';
import { main } from './index.mjs';

// The product daemon is steering-capable (spec 12): point `sumo/db`'s autostart at the rich entry so
// the daemon that wins the LevelDB lock also serves the `steer` op. A superset of the bare storage
// daemon, so all other commands are unaffected. (Respect an explicit override if already set.)
process.env.SUMO_DAEMON_MAIN ||= fileURLToPath(new URL('./daemon-main.mjs', import.meta.url));

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
