/**
 * `roundtable` — cross-agent coordination plugin.
 *
 * Establishes a shared room per project so agents working in the same repo can see each other,
 * announce intent, and avoid silent file collisions via FCFS locking.
 *
 * Architecture:
 * - Presence: tracked via session.started / session.ended / session.dead events + TTL.
 * - Claims: in-process FCFS map on the steer-host runtime (atomic by single event loop).
 * - Room doc: durable KV projection written after each claim decision (display only).
 * - Tools: `roundtable-room` (pull) and `roundtable-announce` (send) projected to MCP + CLI.
 * - Boundary injection: passive `{inject}` line at tool/prompt boundaries when room changes.
 * - Death probe: on claim TTL expiry, push a liveness probe via `sumo.push()` if available.
 *
 * @module roundtable
 */

import path from 'node:path';
import { z } from 'zod';
import { create } from 'sumo/capability';
import { createClaimRegistry } from './claim.mjs';
import { extractFiles } from './files.mjs';
import { persistRoom, readRoom, appendMessage, summarize } from './room.mjs';

/**
 * @typedef {{ enforce: boolean, claimTtlMs: number, graceMs: number, boundaryLine: 'changed-only'|'always' }} RoundtableConfig
 * @typedef {{ name?: string, input?: unknown }} RoundtableTool
 * @typedef {{ harness?: string, cwd: string, lastSeen: number, touchedFiles: string[] }} PresenceEntry
 * @typedef {{ holder: string, since: number }} Claim
 * @typedef {Record<string, unknown> & { sessionId?: string, text: string, intent?: string, files?: string[], ts: number }} RoomMessage
 * @typedef {{ presence: Record<string, PresenceEntry>, claims: Record<string, Claim>, messages: RoomMessage[], agentCount: number }} RoomCommandOutput
 * @typedef {Record<string, unknown> & { message: string, files?: string[], intent?: string, sessionId?: string }} AnnounceInput
 * @typedef {Record<string, unknown> & { sessionId?: string, ts: number, payload: Record<string, unknown> & { sessionId?: string, harness?: string, cwd?: string, tool?: RoundtableTool } }} RoundtableEvent
 * @typedef {{ inject?: string, deny?: string }} RoundtableDecision
 * @typedef {{ files: string[], probedAt: number, timer: ReturnType<typeof setTimeout>|null }} ProbeState
 * @typedef {object} RoundtableSumo
 * @property {(namespace?: string) => import('sumo/plugin').Store} store - Open a plugin-scoped store namespace.
 * @property {(type: string, handler: (event: RoundtableEvent) => unknown|Promise<unknown>, opts?: object) => void} on - Register an observer for normalized events.
 * @property {(action: string, handler: (event: RoundtableEvent) => RoundtableDecision|void|Promise<RoundtableDecision|void>, opts?: object) => void} before - Register a steering gate for prompt or tool boundaries.
 * @property {(capability: unknown) => void} command - Register a capability for CLI, MCP, and programmatic invocation.
 * @property {(type: string, payload?: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<number>} emit - Append a plugin event to the shared event log.
 * @property {(sessionId: string, text: string) => Promise<unknown>} [push] - Send a liveness probe into a running session when the host can drive it.
 * @property {(name: string, handler: () => unknown, meta?: Record<string, unknown>) => void} skill - Publish an optional agent skill.
 * @property {(spec: { skills: Array<{ name: string, source: string }> }) => void} install - Register plugin-owned installation intents.
 * @property {(handler: () => void|Promise<void>) => void} destroy - Register shutdown cleanup.
 */

/**
 * Write tool names that require file-claim gating.
 * This list is intentionally closed: unknown tool names default to no-claim (safe degradation).
 */
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'str_replace_editor', 'str_replace_based_edit_tool', 'multi_edit',
  'Bash', 'bash', 'run_terminal_cmd', 'computer'
]);

/**
 * Register the Roundtable coordination plugin.
 *
 * @access public
 * @param {RoundtableSumo} sumo - Runtime facade used to observe sessions, gate writes, and expose room commands.
 * @param {unknown} options - Plugin configuration validated by `roundtable.sumo.config`.
 * @returns {void} The plugin registers observers, commands, background reaping, and shutdown cleanup.
 */
export default function roundtable(sumo, options) {
  const cfg = /** @type {RoundtableConfig} */ (roundtable.sumo.config.parse(options ?? {}));

  const store = sumo.store('room');
  const registry = createClaimRegistry({ claimTtlMs: cfg.claimTtlMs });

  /** @type {Map<string, PresenceEntry>} */
  const presence = new Map();

  /** @type {RoomMessage[]} Bounded ring of recent announcements. */
  let messages = [];

  /** @type {Map<string, number>} Last room snapshot version seen by each session. */
  const lastSeen = new Map();
  let roomVersion = 0;
  let roomSync = Promise.resolve();

  /** @type {ReturnType<typeof setTimeout>|null} Whether the TTL reaper is running. */
  let reaperTimer = null;
  let destroying = false;

  /**
   * Read the Sumo session id from the spine field, falling back to older payload-shaped events.
   *
   * @access private
   * @param {RoundtableEvent} event - Event delivered by the plugin runtime.
   * @returns {string|undefined} Correlated session id when the event carries one.
   */
  function sessionIdOf(event) {
    return typeof event.sessionId === 'string'
      ? event.sessionId
      : typeof event.payload.sessionId === 'string'
        ? event.payload.sessionId
        : undefined;
  }

  /**
   * Read a string field from the normalized event payload.
   *
   * @access private
   * @param {RoundtableEvent} event - Event whose payload may include the field.
   * @param {'harness'|'cwd'} key - Payload key expected to contain a string.
   * @returns {string|undefined} Payload string when present.
   */
  function payloadString(event, key) {
    const value = event.payload[key];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Produce a timestamp for presence updates.
   *
   * @access private
   * @param {RoundtableEvent} event - Event that may already carry the spine timestamp.
   * @returns {number} Event timestamp, or the current time for legacy payloads without one.
   */
  function eventTime(event) {
    return Number.isFinite(event.ts) ? event.ts : Date.now();
  }

  /**
   * Record a newly started session in live room presence and persist the updated room view.
   *
   * @access private
   * @param {RoundtableEvent} event - Session lifecycle event emitted by the runtime.
   * @returns {Promise<void>} Resolves after live presence and the room projection are updated.
   */
  async function handleSessionStarted(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    const harness = payloadString(event, 'harness');
    const cwd = payloadString(event, 'cwd') ?? process.cwd();
    presence.set(sessionId, { ...(harness ? { harness } : {}), cwd, lastSeen: eventTime(event), touchedFiles: [] });
    roomVersion++;
    await syncRoom();
  }

  /**
   * Remove a finished session from live room presence and persist the updated room view.
   *
   * @access private
   * @param {RoundtableEvent} event - Session lifecycle event emitted by the runtime.
   * @returns {Promise<void>} Resolves after presence cleanup and room persistence complete.
   */
  async function handleSessionEnded(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    cleanupSession(sessionId);
    roomVersion++;
    await syncRoom();
  }

  /**
   * Remove a dead session from live room presence and persist the updated room view.
   *
   * @access private
   * @param {RoundtableEvent} event - Session lifecycle event emitted by the runtime.
   * @returns {Promise<void>} Resolves after presence cleanup and room persistence complete.
   */
  async function handleSessionDead(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    cleanupSession(sessionId);
    roomVersion++;
    await syncRoom();
  }

  /**
   * Refresh a session's liveness and claim TTL after an observed tool invocation.
   *
   * @access private
   * @param {RoundtableEvent} event - Session tool event observed by the plugin.
   * @returns {void} The session presence entry is updated in memory when one exists.
   */
  function handleSessionToolActivity(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    const entry = presence.get(sessionId);
    if (entry) {
      entry.lastSeen = eventTime(event);
      registry.refreshAll(sessionId);
    }
  }

  /**
   * Refresh a session's last-seen timestamp after a session message event.
   *
   * @access private
   * @param {RoundtableEvent} event - Session message event observed by the plugin.
   * @returns {void} The session presence entry is updated in memory when one exists.
   */
  function handleSessionMessage(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    const entry = presence.get(sessionId);
    if (entry) entry.lastSeen = eventTime(event);
  }

  // ── Presence tracking ──────────────────────────────────────────────────────────────────────────

  sumo.on('session.started', handleSessionStarted);
  sumo.on('session.ended', handleSessionEnded);
  sumo.on('session.dead', handleSessionDead);

  // Refresh presence TTL on any session activity.
  sumo.on('session.tool', handleSessionToolActivity);
  sumo.on('session.message', handleSessionMessage);

  /**
   * Remove transient room presence and file claims when a session leaves.
   *
   * @access private
   * @param {string} sessionId - Session leaving the room.
   * @returns {void} Presence and claims for that session are removed from memory.
   */
  function cleanupSession(sessionId) {
    presence.delete(sessionId);
    registry.releaseAll(sessionId);
  }

  /**
   * Track files touched by observed tool calls so peers can see recent local activity.
   *
   * @access private
   * @param {RoundtableEvent} event - Session tool event emitted by the runtime.
   * @returns {void} The presence record gains the newest touched files when targets are extractable.
   */
  function trackTouchedFiles(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    const entry = presence.get(sessionId);
    if (!entry) return;
    const files = extractFiles(event, entry.cwd);
    if (files.length > 0) {
      const set = new Set([...entry.touchedFiles, ...files]);
      entry.touchedFiles = [...set].slice(-20);
    }
  }

  // ── Passive file tracking (observation — only updates touchedFiles, no claim decisions) ───────

  sumo.on('session.tool', trackTouchedFiles);

  /**
   * Gate write-capable tool calls behind the room claim registry.
   *
   * @access private
   * @param {RoundtableEvent} event - Pending tool invocation presented to the boundary hook.
   * @returns {Promise<RoundtableDecision|void>} Claim denial or injection when coordination is needed.
   */
  async function gateWriteTool(event) {
    const toolName = event.payload?.tool?.name;
    if (typeof toolName !== 'string' || !WRITE_TOOLS.has(toolName)) return;

    const sessionId = sessionIdOf(event);
    if (!sessionId) return;

    const cwd = presence.get(sessionId)?.cwd ?? process.cwd();
    const files = extractFiles(event, cwd);

    registry.refreshAll(sessionId);

    if (files.length === 0) {
      if (presence.size > 1) {
        return { inject: '[roundtable] Write command targets could not be extracted — no file claim placed. Use roundtable-room to check if others are editing the same files.' };
      }
      return;
    }

    const result = registry.acquireAll(files, sessionId);
    if (result.ok) {
      void syncRoom();
      return;
    }

    const holderInfo = presence.get(result.holder);
    const holderDesc = holderInfo?.harness ? `${result.holder.slice(4, 12)} (${holderInfo.harness})` : result.holder.slice(4, 12);

    const inject = cfg.enforce
      ? `[roundtable] '${path.basename(result.file)}' is held by agent ${holderDesc}. Use roundtable-room to check status, roundtable-announce to coordinate. Retry shortly.`
      : `[roundtable] '${path.basename(result.file)}' is being edited by agent ${holderDesc}.`;

    if (!cfg.enforce) return { inject };
    return { deny: `File held by agent ${holderDesc} — retry after they finish`, inject };
  }

  // ── Collision → FCFS claim (before 'tool') ───────────────────────────────────────────────────

  sumo.before('tool', gateWriteTool);

  /**
   * Inject a one-line room summary at prompt boundaries when peer activity changed.
   *
   * @access private
   * @param {RoundtableEvent} event - Prompt boundary event emitted by the runtime.
   * @returns {Promise<RoundtableDecision|void>} Injected room summary when another agent is active.
   */
  async function injectRoomSummary(event) {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;
    if (presence.size <= 1) return;

    const myVersion = lastSeen.get(sessionId) ?? -1;
    if (cfg.boundaryLine === 'changed-only' && myVersion >= roomVersion) return;

    lastSeen.set(sessionId, roomVersion);

    const room = { presence: snapshotPresence(), claims: registry.snapshot() };
    const line = summarize(room, sessionId);
    return line ? { inject: line } : undefined;
  }

  // ── Boundary injection (changed-only presence/collision line) ────────────────────────────────

  sumo.before('prompt', injectRoomSummary);

  // ── Tools: roundtable-room (pull) and roundtable-announce (send) ─────────────────────────────

  sumo.command(create({
    name: 'roundtable-room',
    title: 'Roundtable Room',
    description: 'Read the current agent room state: presence, file claims, recent announcements',
    inputSchema: z.object({}).optional(),
    outputSchema: z.object({
      presence: z.record(z.string(), z.unknown()),
      claims: z.record(z.string(), z.unknown()),
      messages: z.array(z.unknown()),
      agentCount: z.number()
    }),
    surfaces: ['mcp', 'cli', 'programmatic'],
    /**
     * Read live room state, falling back to durable store on fresh activation.
     *
     * @access public
     * @returns {Promise<RoomCommandOutput>} Current room state plus active-agent count.
     */
    async exec() {
      // The in-process state is authoritative while the runtime is alive.
      // When this is a freshly-reactivated runtime (presence is empty AND no live claims exist),
      // bootstrap from the durable store so crash-recovery and idle-eviction round-trips work.
      const liveClaims = registry.snapshot();
      const hasLiveState = presence.size > 0 || Object.keys(liveClaims).length > 0;
      if (hasLiveState) {
        return {
          presence: snapshotPresence(),
          claims: liveClaims,
          messages,
          agentCount: presence.size
        };
      }
      const room = await readRoom(store);
      return { ...room, agentCount: Object.keys(room.presence).length };
    }
  }));

  sumo.command(create({
    name: 'roundtable-announce',
    title: 'Roundtable Announce',
    description: 'Post an announcement to the agent room (intent, status, coordination message)',
    inputSchema: z.object({
      message: z.string().min(1).describe('The announcement text'),
      files: z.array(z.string()).optional().describe('Files you plan to touch (optional)'),
      intent: z.string().optional().describe('Intent type: e.g. "refactor", "fix", "add"'),
      sessionId: z.string().optional().describe('Sumo session id of the announcing agent')
    }),
    outputSchema: z.object({ ok: z.boolean(), ts: z.number() }),
    surfaces: ['mcp', 'cli', 'programmatic'],
    /**
     * Add a durable room announcement and mirror it to the event stream.
     *
     * @access public
     * @param {AnnounceInput} input - Validated announcement payload from CLI, MCP, or programmatic callers.
     * @returns {Promise<{ ok: true, ts: number }>} Acknowledgement with the stored announcement timestamp.
     */
    async exec(input) {
      const ts = Date.now();
      const msg = {
        text: input.message, ts,
        ...(input.files ? { files: input.files } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      };
      messages = appendMessage(messages, msg);
      roomVersion++;
      await sumo.emit('roundtable.announce', msg, {
        dedupe: `roundtable:announce:${ts}`,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      });
      await syncRoom();
      return { ok: true, ts };
    }
  }));

  // ── Death probe: on TTL expiry, push liveness check before reclaiming ─────────────────────────

  /** @type {Map<string, ProbeState>} Active liveness probes keyed by holder session id. */
  const probes = new Map();

  /**
   * Background TTL reaper — runs every claimTtlMs/5 to catch dead holders.
   *
   * @access private
   * @returns {Promise<void>} Resolves after stale claims are probed or expired and the next tick is scheduled.
   */
  async function runReaper() {
    if (destroying) return;
    const now = Date.now();
    // findExpired returns candidates WITHOUT deleting them. Claims only disappear after death is
    // confirmed (probe timeout or non-drivable session): expireConfirmed() removes each one.
    // This prevents a race where another session acquires a file during the grace window and
    // then the original holder proves liveness — the claim would already be gone.
    const expired = registry.findExpired(now);

    for (const { file, holder } of expired) {
      if (probes.has(holder)) continue; // already probing this holder

      const holderP = presence.get(holder);
      if (holderP && sumo.push) {
        const probe = probes.get(holder) ?? { files: [], probedAt: now, timer: null };
        if (!probe.files.includes(file)) probe.files.push(file);
        probe.timer = setTimeout(() => finishProbe(holder), cfg.graceMs);
        probe.timer.unref();
        probes.set(holder, probe);
        // Probe: fire-and-forget, check back after graceMs.
        void sumo.push(holder, `[roundtable] Are you still editing ${path.basename(file)}? If not, the claim has been released.`).catch(() => {});
      } else {
        // Non-drivable session or no push capability: confirm expiry immediately.
        registry.expireConfirmed(file);
        if (!presence.get(holder)) {
          // No presence record either — full cleanup.
          registry.releaseAll(holder);
        }
        roomVersion++;
        void syncRoom();
      }
    }

    if (!destroying) reaperTimer = setTimeout(runReaper, cfg.claimTtlMs / 5);
  }

  /**
   * Called after the grace window: if the holder showed liveness, renew; else confirm expiry.
   *
   * @access private
   * @param {string} sessionId - Holder whose probe grace window has elapsed.
   * @returns {void} Claims are renewed for live holders or released for silent holders.
   */
  function finishProbe(sessionId) {
    const probe = probes.get(sessionId);
    if (!probe) return;
    if (probe.timer) clearTimeout(probe.timer);
    probes.delete(sessionId);

    const p = presence.get(sessionId);
    if (p && Date.now() - p.lastSeen < cfg.graceMs) {
      // Holder is alive — refresh all its claims with a fresh TTL (they were never removed).
      registry.refreshAll(sessionId);
    } else {
      // Holder silent through grace window: confirm each probed file as expired, then full cleanup.
      for (const file of probe.files) registry.expireConfirmed(file);
      cleanupSession(sessionId);
      roomVersion++;
      void syncRoom();
    }
  }

  // ── Room persistence helper ─────────────────────────────────────────────────────────────────

  /**
   * Persist the current in-memory room snapshot for crash/idle recovery.
   *
   * @access private
   * @returns {Promise<void>} Resolves after the room projection is stored.
   */
  async function syncRoom() {
    const presenceSnapshot = snapshotPresence();
    const claimSnapshot = registry.snapshot();
    const messageSnapshot = messages.slice();
    roomSync = roomSync.then(() => persistRoom(store, presenceSnapshot, claimSnapshot, messageSnapshot));
    await roomSync;
  }

  /**
   * Copy the live presence map into the durable room document shape.
   *
   * @access private
   * @returns {Record<string, PresenceEntry>} Plain object keyed by Sumo session id.
   */
  function snapshotPresence() {
    return /** @type {Record<string, PresenceEntry>} */ (Object.fromEntries(presence));
  }

  // ── Skills / encouragement ──────────────────────────────────────────────────────────────────

  sumo.skill('roundtable-coordinate', () => {}, {
    description: 'Coordinate with other agents via roundtable-announce and roundtable-room'
  });
  sumo.install({ skills: [{ name: 'roundtable-coordinate', source: './skills/announce.md' }] });

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────────────

  // Start the TTL reaper once the runtime activates.
  // (Activation happens synchronously; the reaper fires after claimTtlMs/10 first tick.)
  reaperTimer = setTimeout(runReaper, cfg.claimTtlMs / 5);

  sumo.destroy(async () => {
    destroying = true;
    if (reaperTimer) clearTimeout(reaperTimer);
    for (const probe of probes.values()) {
      if (probe.timer) clearTimeout(probe.timer);
    }
    probes.clear();
    await roomSync.catch(() => {});
    // Release claims for this runtime's tracked sessions. Do NOT write the room doc here:
    // non-steer runtimes (sumo mcp, CLI capability invocation) also activate this plugin with
    // empty presence/claims, and their destroy() would overwrite the steer-host's live room doc
    // with an empty snapshot. The room doc is a display projection — let it go stale on
    // shutdown rather than actively wipe it. It will be refreshed on the next steer event.
    for (const sessionId of presence.keys()) registry.releaseAll(sessionId);
  });
}

roundtable.sumo = {
  name: 'roundtable',
  config: z.object({
    enforce: z.boolean().default(true),
    claimTtlMs: z.number().int().positive().default(300_000),
    graceMs: z.number().int().positive().default(45_000),
    /** 'changed-only' injects at boundaries only when room state changed; 'always' injects on every boundary */
    boundaryLine: z.enum(['changed-only', 'always']).default('changed-only')
  }).prefault({})
};
