/**
 * `sumo/db` — the storage + event-log layer's public surface.
 *
 * The daemon is the sole LevelDB owner and event hub; everything else is a client of it via
 * `open()`, which returns the `SumoDb` API and hides the socket entirely (specs 01/02).
 *
 * @module sumo/db
 */

/**
 * Public daemon client returned by `open()`.
 * @typedef {Awaited<ReturnType<typeof import('./client.mjs').open>>} SumoDb
 */

export { open } from './client.mjs';
export { id, SessionSchema, EventInput, ID_REGEXP } from './schema.mjs';
export { key } from './keyspace.mjs';
export { SumoError } from './errors.mjs';
