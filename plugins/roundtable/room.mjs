/**
 * Room state helpers — reads and folds the current in-process state into the durable room doc.
 *
 * The room doc is a DERIVED PROJECTION written for display and crash-recovery; the in-process
 * claim registry is the lock authority. Writes use `store.merge()` (atomic daemon mergeDoc) so
 * concurrent writes from the steer-host runtime to its own room key can't lose-update.
 *
 * Key layout inside the plugin's `store('room')` namespace:
 *   `state`    — the full room snapshot: { presence, claims, messages }
 *
 * @module roundtable/room
 */

/** Maximum number of recent announcements to keep in the room ring buffer. */
const MAX_MESSAGES = 50;

/**
 * @typedef {{ holder: string, since: number }} Claim
 * @typedef {{ harness?: string, cwd: string, lastSeen: number, touchedFiles: string[] }} PresenceEntry
 * @typedef {{ sessionId?: string, text: string, intent?: string, files?: string[], ts: number }} RoomMessage
 * @typedef {{ presence: Record<string, PresenceEntry>, claims: Record<string, Claim>, messages: RoomMessage[] }} RoomState
 */

/**
 * Write the current room snapshot to the durable store.
 * Uses `set` (last-writer-wins) — the steer-host runtime is the single writer for this key, so
 * there's no concurrent-write issue. Needed to correctly reflect removals (mergeDoc would fill
 * gaps and never remove a departed session's presence entry).
 * Fire-and-forget (the caller does not await this) — a missed write only affects display/recovery.
 *
 * @access public
 * @param {import('sumo/plugin').Store} store - Plugin-scoped `room` namespace store.
 * @param {Record<string, PresenceEntry>} presence - Live sessions keyed by Sumo session id.
 * @param {Record<string, Claim>} claims - Current file claims keyed by canonical file path.
 * @param {RoomMessage[]} messages - Recent coordination announcements to display in the room.
 * @returns {Promise<void>} Resolves after the room projection is written.
 */
export async function persistRoom(store, presence, claims, messages) {
  await store.set('state', { presence, claims, messages });
}

/**
 * Read the last persisted room snapshot. Returns a safe default if not yet written.
 *
 * @access public
 * @param {import('sumo/plugin').Store} store - Plugin-scoped `room` namespace store.
 * @returns {Promise<RoomState>} Last room projection or an empty state before the first write.
 */
export async function readRoom(store) {
  const doc = /** @type {Partial<RoomState>|undefined} */ (await store.get('state'));
  return {
    presence: doc?.presence ?? {}, claims: doc?.claims ?? {}, messages: doc?.messages ?? []
  };
}

/**
 * Append one message to the ring buffer, evicting the oldest when full.
 *
 * @access public
 * @param {RoomMessage[]} messages - Existing announcement ring buffer.
 * @param {RoomMessage} msg - New announcement to append.
 * @returns {RoomMessage[]} Ring buffer containing the newest message and at most `MAX_MESSAGES` entries.
 */
export function appendMessage(messages, msg) {
  const ring = [...messages, msg];
  return ring.length > MAX_MESSAGES ? ring.slice(ring.length - MAX_MESSAGES) : ring;
}

/**
 * Format a compact room summary line for boundary injection.
 *
 * @access public
 * @param {{ presence: Record<string, PresenceEntry>, claims: Record<string, Claim> }} room - Current room state to summarize.
 * @param {string} selfSessionId - Session receiving the boundary injection.
 * @returns {string|null} One-line status update, or `null` when no other sessions are active.
 */
export function summarize(room, selfSessionId) {
  const others = Object.keys(room.presence).filter((id) => id !== selfSessionId);
  const collisions = Object.entries(room.claims)
    .filter(([, c]) => c.holder !== selfSessionId)
    .map(([file]) => file);
  if (others.length === 0) return null;
  const parts = [`${others.length} other agent${others.length === 1 ? '' : 's'} active`];
  if (collisions.length > 0) {
    parts.push(`${collisions.length} file conflict${collisions.length === 1 ? '' : 's'}: ${collisions.slice(0, 3).join(', ')}${collisions.length > 3 ? '…' : ''}`);
  }
  return `[roundtable] ${parts.join('; ')}`;
}
