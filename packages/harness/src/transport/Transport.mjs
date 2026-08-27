/**
 * The abstract transport contract — Primus's "transformer", assigned to a harness's `transport` prop
 * (). The harness writes its logic against a normalized `Session`; the transport instance handles
 * the backend-kind difference (pipe byte stream vs server request/response). Swapping the instance,
 * not an inheritance fork in the adapter, is what spans the two kinds.
 *
 * REQUIRED on every transport: `open` / `frames` / `close` / `kill` / `health`.
 *
 * OPTIONAL effectors — present ONLY on transports that actually have them. The `Harness` base
 * presence-probes (`typeof transport.send === 'function'`) and gates each through the adapter's `can`,
 * so an absent effector degrades to `SUMO_CAP_UNSUPPORTED` rather than being faked (§3a/§4):
 *   - `send(bytes)`           — pipe kind: write bytes to stdin
 *   - `request(method, params)` — server kind: a correlated request, resolves to a `Result`
 *   - `respondApproval(decision)` — server kind w/ server-initiated approvals
 *   - `interrupt()`           — both kinds: interrupt the active turn (pipe→SIGINT/C-c; server→turn/interrupt)
 *   - `key(name)` / `capture()`   — pipe kind w/ a tmux pane (interactive)
 *
 * This base intentionally does NOT define the optional effectors, so `typeof` presence-probing is
 * truthful: a concrete transport adds exactly the effectors it supports.
 *
 * @module sumo/harness/transport/Transport
 *
 * @typedef {object} Frame - one inbound unit (a parsed JSON line, an SSE event, a JSON-RPC message).
 *
 * @typedef {object} TransportHealth
 * @property {boolean} alive
 * @property {number} [heartbeat] - monotonically increases on inbound activity (stall detection)
 */
import { SumoError } from 'sumo/error';

/**
 * Transport implementation.
 *
 * @access public
 * @class
 */
export class Transport {
  /** The backend kind this transport implements (`'pipe'` | `'server'`). */
  kind = 'pipe';

  /**
   * Start the process / open the connection and run any protocol handshake the channel itself owns
   * (e.g. a server transport's `initialize`). Resolves once inbound frames can flow.
   *
   * @access public
   * @returns {Promise<void>} Promise that rejects because the base transport is abstract.
   */
  // eslint-disable-next-line class-methods-use-this, require-await
  async open() {
    throw new SumoError({ name: 'harness', method: 'Transport.open', code: 'SUMO_NOT_IMPLEMENTED', message: 'Transport.open is abstract' });
  }

  /**
   * Inbound frames, in arrival order, until the channel closes.
   *
   * @access public
   * @returns {AsyncIterable<Frame>} Async frame stream supplied by a concrete transport.
   */
  // eslint-disable-next-line class-methods-use-this
  frames() {
    throw new SumoError({ name: 'harness', method: 'Transport.frames', code: 'SUMO_NOT_IMPLEMENTED', message: 'Transport.frames is abstract' });
  }

  /**
   * Liveness for the base's stall/blocked detection.
   *
   * @access public
   * @returns {TransportHealth} Base liveness state for an unopened transport.
   */
  // eslint-disable-next-line class-methods-use-this
  get health() {
    return { alive: false };
  }

  /**
   * Adjust launch mode before `open()`. Concrete transports that care about mode override this.
   *
   * @access public
   * @param {'default'|'interactive'|string} _mode - Launch mode requested by the harness.
   * @returns {void} Base transport ignores mode changes.
   */
  // eslint-disable-next-line class-methods-use-this
  setMode(_mode) {}

  /**
   * Close the transport gracefully.
   *
   * @access public
   * @returns {Promise<void>} Promise that rejects because the base transport is abstract.
   */
  // eslint-disable-next-line class-methods-use-this, require-await
  async close() {
    throw new SumoError({ name: 'harness', method: 'Transport.close', code: 'SUMO_NOT_IMPLEMENTED', message: 'Transport.close is abstract' });
  }

  /**
   * Force-kill the transport.
   *
   * @access public
   * @returns {Promise<void>|void} Always throws because the base transport is abstract.
   */
  // eslint-disable-next-line class-methods-use-this
  kill() {
    throw new SumoError({ name: 'harness', method: 'Transport.kill', code: 'SUMO_NOT_IMPLEMENTED', message: 'Transport.kill is abstract' });
  }
}
