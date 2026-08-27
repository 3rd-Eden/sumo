/**
 * The STEERING daemon process entry (spec 12). This is the rich counterpart to
 * `sumo/db`'s storage-only `daemon/main.mjs`: it co-hosts the project-scoped plugin runtimes so a
 * `sumo forward` hook can reach a warm runtime over the control socket's `steer` op.
 *
 * `sumo/db`'s client spawns THIS entry (via `SUMO_DAEMON_MAIN`) instead of the bare storage entry, so
 * the daemon that wins the LevelDB lock is a superset that also serves `steer`. If it loses the lock,
 * it exits cleanly and the client connects to the winner (same race-safe lock as the bare daemon).
 *
 * @module sumo/cli/daemon-main
 */

import { startSteeringDaemon } from './daemon-host.mjs';

const idleShutdownMs = process.env.SUMO_IDLE_MS !== undefined ? Number(process.env.SUMO_IDLE_MS) : undefined;
const sweepIntervalMs = process.env.SUMO_SWEEP_MS !== undefined ? Number(process.env.SUMO_SWEEP_MS) : undefined;
const projectIdleMs = process.env.SUMO_PROJECT_IDLE_MS !== undefined ? Number(process.env.SUMO_PROJECT_IDLE_MS) : undefined;
const dbPath = process.env.SUMO_DB;
const socket = process.env.SUMO_SOCKET;

try {
  const { close } = await startSteeringDaemon({
    ...(idleShutdownMs !== undefined ? { idleShutdownMs } : {}),
    ...(sweepIntervalMs !== undefined ? { sweepIntervalMs } : {}),
    ...(projectIdleMs !== undefined ? { projectIdleMs } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(socket ? { socket } : {}),
    /**
     * Exit the standalone daemon process when the host closes itself.
     *
     * @access public
     * @returns {never} This callback terminates the process immediately.
     */
    onClose() { return process.exit(0); }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { close().then(() => process.exit(0)); });
} catch (err) {
  if (err?.code === 'SUMO_DB_LOCKED') process.exit(0); // winner is already serving
  process.stderr.write(`sumo steering daemon failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
}
