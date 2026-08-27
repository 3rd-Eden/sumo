/**
 * Fixture module with no default export, used to verify plugin loader classification.
 *
 * @module sumo/plugin/test/fixtures/no-default-plugin
 */

/** Named export intentionally not accepted by `sumo.use('module')`. */
export const notAPlugin = true;
