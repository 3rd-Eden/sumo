/**
 * A thin tmux wrapper for the `Pipe` transport's interactive (human-takeover) mode (spec 04 PTY
 * decision: tmux backend). It is deliberately small — tmux is the external binary that owns the
 * pseudo-terminal, detach/attach, and human takeover; Sumo only shells out to it.
 *
 * IMPORTANT (the committed architecture, not a caveat): a process launched *inside* a tmux pane has
 * its stdout rendered to the terminal, mixed with TUI redraws/ANSI. Scraping clean stream-json back
 * out of `capture-pane` is the "half-works" trap, so Sumo does NOT treat the pane as a clean event
 * source. In pane mode live events are observed from the on-disk transcript (agent-artifacts/09);
 * tmux here provides only the interactive control surface (`send-keys`) and a raw snapshot
 * (`capture-pane`). See `CapabilitiesSchema.observationSource` = `'transcript-file'`.
 *
 * @module sumo/harness/transport/tmux
 */

import { execFile } from 'node:child_process';
import { probeBinary } from '../base/probe.mjs';

/**
 * Run `tmux <args>` and resolve its stdout. Rejects (with stderr) on a non-zero exit — a tmux failure
 * is a real operational failure the caller maps to a `Result`, not something to swallow.
 *
 * @access private
 * @param {string[]} args - Argument object accepted by `tmux`.
 * @returns {Promise<string>} Promise resolving to the `tmux` result.
 */
function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tmux ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * Launch a command in a new detached tmux session/pane. The command runs in `cwd`; the session name
 * is the handle every other op targets.
 *
 * @access public
 * @param {{ session: string, command: string, args?: string[], cwd?: string }} spec - Object fields used to build the normalized value.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
export async function tmuxSpawn({ session, command, args = [], cwd }) {
  const launchArgs = ['new-session', '-d', '-s', session];
  if (cwd) launchArgs.push('-c', cwd);
  // `--` then the command + args: tmux execs them directly (no shell word-splitting of our args).
  launchArgs.push('--', command, ...args);
  await tmux(launchArgs);
}

/**
 * Send a key (or literal text) to the session's active pane. tmux interprets named keys (`Enter`,
 * `Escape`, `C-c`); arbitrary text is sent with `-l` (literal) so it is not mis-parsed as a key name.
 *
 * @access public
 * @param {string} session - Session supplied to `tmuxSendKeys`.
 * @param {string} key - a tmux key name (Enter/Escape/C-c/…) or literal text
 * @param {{ literal?: boolean }} opts - Options read by this operation.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
export async function tmuxSendKeys(session, key, { literal = false } = {}) {
  const args = ['send-keys', '-t', session];
  if (literal) args.push('-l');
  args.push(key);
  await tmux(args);
}

/**
 * Capture the visible content of the session's active pane as plain text (`-p` to stdout).
 *
 * @access public
 * @param {string} session - Session supplied to `tmuxCapture`.
 * @returns {Promise<string>} Promise resolving to the `tmuxCapture` result.
 */
export function tmuxCapture(session) {
  return tmux(['capture-pane', '-p', '-t', session]);
}

/**
 * Kill a tmux session (idempotent: a missing session resolves rather than rejecting).
 *
 * @access public
 * @param {string} session - Session supplied to `tmuxKill`.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
export async function tmuxKill(session) {
  try {
    await tmux(['kill-session', '-t', session]);
  } catch {
    // session already gone — nothing to kill
  }
}

/**
 * Is tmux available on this machine? Used to degrade `key`/`capture` honestly when it is absent.
 *
 * @access public
 * @returns {Promise<boolean>} Whether the `tmux` binary is available.
 */
export async function tmuxAvailable() {
  return (await probeBinary('tmux', { versionArgs: ['-V'] })).available;
}
