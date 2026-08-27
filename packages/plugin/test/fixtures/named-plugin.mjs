/** Fixture: a string-loaded plugin whose declared `.sumo.name` differs from its function name and
 *  module specifier — used to verify id canonicalization + config-key matching. */
import { z } from 'zod';

/** Implement internalImpl. */ export default function internalImpl(sumo, options) {
  sumo.command('named-opts', /** Run the callback. */ () => options);
}

internalImpl.sumo = { name: 'declared-name', config: z.object({ tag: z.string() }) };
