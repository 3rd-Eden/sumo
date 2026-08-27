/**
 * Detached daemon entrypoint. The client spawns this with `node` when no live socket is found
 * (auto-start). If another daemon already holds the LevelDB lock, this loser exits cleanly and the
 * client connects to the winner — the lock makes the spawn race safe (spec 02).
 *
 * @module sumo/db/daemon/main
 */

import { start } from './host.mjs';

const idleShutdownMs = process.env.SUMO_IDLE_MS !== undefined ? Number(process.env.SUMO_IDLE_MS) : undefined;
const sweepIntervalMs = process.env.SUMO_SWEEP_MS !== undefined ? Number(process.env.SUMO_SWEEP_MS) : undefined;
const dbPath = process.env.SUMO_DB;
const socket = process.env.SUMO_SOCKET;

try {
  const daemon = await start({ idleShutdownMs, sweepIntervalMs, ...(dbPath ? { dbPath } : {}), ...(socket ? { socket } : {}) });
  daemon.onClose(() => process.exit(0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { daemon.close(); });
} catch (err) {
  if (err?.code === 'SUMO_DB_LOCKED') process.exit(0); // winner is already serving
  process.stderr.write(`sumo daemon failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
}
