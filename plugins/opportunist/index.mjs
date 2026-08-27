/**
 * `opportunist` — event-driven opportunistic issue discovery plugin.
 *
 * Watches the unified Sumo event log for issues a parent agent notices but leaves outside its
 * original mission. The plugin entrypoint stays thin: config is parsed here, while runtime behavior
 * is registered by `engine.mjs`.
 *
 * @module sumo/plugins/opportunist
 */

import { OpportunistConfig } from './config.mjs';
import { registerOpportunistEngine } from './engine.mjs';

export { OpportunistConfig } from './config.mjs';
export { detectText, verificationId } from './detect.mjs';
export { registerOpportunistEngine } from './engine.mjs';
export { parseResultBlock, parseTriageBlock, repairPrompt, triagePrompt } from './prompt.mjs';

/**
 * Register the Opportunist plugin.
 *
 * @access public
 * @param {import('./engine.mjs').SumoFacade} sumo - Sumo plugin facade.
 * @param {unknown} options - Untrusted plugin options.
 * @returns {void} Registers commands and observers.
 */
export default function opportunist(sumo, options) {
  registerOpportunistEngine(sumo, OpportunistConfig.parse(options ?? {}));
}

opportunist.sumo = {
  name: 'opportunist',
  config: OpportunistConfig
};
