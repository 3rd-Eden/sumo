/**
 * `sumo/messenger` — the messaging adapter framework. It answers "where does work come from, and
 * where do results go back to?" A messenger ADAPTER (a medium integration like GitHub/Slack/Jira) is
 * shipped as a PLUGIN that extends `Messenger`, declares `id`/`can`/`config`, and implements a few
 * short medium primitives (`*work`/`say`/`mark`, optional `status`/`review`/`react`, and — for a
 * distributed medium — `touch`/`pulse`/`pulses`). The base (here) owns ingress, the claim lifecycle,
 * the claims mirror, event emission, redaction, capability degradation, and proof-of-life plumbing.
 * The plugin registers it via `sumo.messenger(id, (mctx) => new Cls(mctx))`.
 *
 * This package is medium-agnostic framework: the base + the contracts only. The first adapter
 * (GitHub) lives with its plugin (`plugins/github`), not here.
 *
 * @module sumo/messenger
 */

export { Messenger } from './base/Messenger.mjs';
export { HttpMessenger, HttpMessengerConfig, createHttpMessengerServer } from '../reference/http.mjs';
export { ok, fail, isResult, CAP_UNSUPPORTED, ErrorSchema, WorkSchema } from './schema.mjs';
