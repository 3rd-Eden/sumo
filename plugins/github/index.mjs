/**
 * The GitHub plugin: registers the GitHub messenger adapter. Work (labeled issues) flows in via the
 * adapter's `*work()`; results, claims, and proof-of-life flow back out through its medium primitives.
 * A workflow plugin consumes the normalized `work` and never names "github" ().
 *
 * The adapter's config is validated at this boundary: the runtime parses the `plugins.github` slice
 * against the declared `GitHubConfig` (applying defaults) and hands the validated result in as
 * `options`; we inject that as the messenger's config (the raw `mctx.config` is unvalidated).
 *
 * @param {import('sumo').SumoHost} sumo - Sumo supplied to `import`.
 * @param {import('zod').infer<typeof GitHubConfig>} options - Options read by this operation.
 */
import { GitHubMessenger, GitHubConfig } from './github.mjs';

export { GitHubMessenger, GitHubConfig } from './github.mjs';

/**
 * @typedef {{ messenger: (id: string, factory: (context: Record<string, unknown>) => unknown) => void }} GitHubPluginHost
 */

/**
 * Register the GitHub messenger adapter with validated plugin config.
 *
 * @access public
 * @param {import('sumo').SumoHost} sumo - Sumo supplied to `github`.
 * @param {import('zod').infer<typeof GitHubConfig>} options - Options read by this operation.
 * @returns {void} Completes without producing a value.
 */
export default function github(sumo, options) {
  const host = /** @type {GitHubPluginHost} */ (sumo);

  /**
   * Create the GitHub messenger with the plugin-validated config slice.
   *
   * @access private
   * @param {Record<string, unknown>} mctx - Messenger context supplied by the Sumo runtime.
   * @returns {GitHubMessenger} Messenger instance bound to the validated plugin config.
   */
  function createGitHubMessenger(mctx) {
    return new GitHubMessenger({ ...mctx, config: options });
  }

  host.messenger('github', createGitHubMessenger);
}

github.sumo = {
  name: 'github',
  config: GitHubConfig
};
