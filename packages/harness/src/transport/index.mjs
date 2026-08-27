/**
 * The harness transport family (): the swappable "transformer" assigned to a harness's
 * `transport` prop. `Transport` is the abstract contract; `Pipe` and `CodexAppServer` are the two
 * concrete kinds this batch builds (a pipe + the Codex server). The server kind is intentionally
 * exported under its concrete name, not a generic `Server`, since it is sampled from Codex alone.
 *
 * @module sumo/harness/transport
 */

export { Transport } from './Transport.mjs';
export { Pipe } from './Pipe.mjs';
export { CodexAppServer } from './CodexAppServer.mjs';
export { CopilotServer } from './CopilotServer.mjs';
export { Subprocess } from './Subprocess.mjs';
