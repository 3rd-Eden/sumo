/**
 * The CLI generator (spec 16): the CLI surface of the capability catalog. A registered capability
 * surfaced on the CLI gets its subcommand for free — projected from the catalog onto a `commander`
 * command (commander owns flag parsing, type coercion, `--help`, choices, and usage errors; we only
 * map the catalog's JSON Schema onto its option model). Two jobs:
 *   - `buildCapabilityCommand` — catalog entry → a configured `commander` `Command`.
 *   - `capabilityRows` / `reservedCliCollisions` — the generated listing + collision diagnostics for
 *     `sumo commands`.
 *
 * @module sumo/cli/capabilities
 */

import { Command, Option } from 'commander';

/**
 * Map one catalog input-schema property to a `commander` Option. Coercion and validation hints come
 * from the JSON Schema zod emits: `boolean` → a bare flag; `enum` → `.choices()`; `number`/`integer`
 * → `.argParser(Number)`; a `default` seeds the value; a non-defaulted required property is made
 * mandatory (commander errors if missing). The capability's own zod schema still validates in
 * `invoke()` — this is the ergonomic front, not the source of truth.
 *
 * @access private
 * @param {string} name - Schema used for validation.
 * @param {Record<string, unknown>} schema - Schema used for validation.
 * @param {boolean} mandatory - Whether the option is required.
 * @returns {Option} Option returned by `optionFor`.
 */
function optionFor(name, schema, mandatory) {
  const desc = typeof schema.description === 'string' ? schema.description : '';
  if (schema.type === 'boolean') {
    const o = new Option(`--${name}`, desc);
    if ('default' in schema) o.default(schema.default);
    return o; // a boolean flag is presence-based; mandatory has no meaning
  }
  const o = new Option(`--${name} <value>`, desc);
  if (Array.isArray(schema.enum)) o.choices(schema.enum.map(String));
  if (schema.type === 'number' || schema.type === 'integer') o.argParser(Number);
  if ('default' in schema) o.default(schema.default);
  if (mandatory) o.makeOptionMandatory();
  return o;
}

/**
 * Build a `commander` `Command` for one CLI-surfaced capability catalog entry. The args bag handed to
 * `action(name, args, command)` is built strictly from the capability's DECLARED input properties — so
 * global flags (`--json`/`--config`) the caller may attach never leak into the validated args. A
 * capability with no input schema takes no flags on the CLI (declare an `inputSchema` to expose
 * flags); it is still invocable bare and on its other surfaces.
 *
 * @access public
 * @param {{ name: string, title?: string, description?: string, inputSchema?: { properties?: Record<string, unknown>, required?: string[] } }} entry - Entry consumed by `buildCapabilityCommand`.
 * @param {(name: string, args: Record<string, unknown>, command: Command) => unknown} action - Action supplied to `buildCapabilityCommand`.
 * @returns {Command} Command returned by `buildCapabilityCommand`.
 */
export function buildCapabilityCommand(entry, action) {
  // exitOverride so a usage error (bad flag, missing required, invalid choice) THROWS a CommanderError
  // for `main()` to map to an exit code — NOT `process.exit()`. commander does not propagate the
  // parent program's exitOverride to a command attached via `addCommand`, so set it per command.
  const cmd = new Command(entry.name).description(entry.description || entry.title || entry.name).exitOverride();
  const props = /** @type {Record<string, unknown>} */ (entry.inputSchema?.properties ?? {});
  const required = new Set(entry.inputSchema?.required ?? []);
  for (const [name, schema] of Object.entries(props)) {
    const schemaObj = /** @type {Record<string, unknown>} */ (schema);
    const mandatory = required.has(name) && !('default' in schemaObj);
    cmd.addOption(optionFor(name, schemaObj, mandatory));
  }
  cmd.action(async (opts, command) => {
    const given = /** @type {Record<string, unknown>} */ (opts);
    /** @type {Record<string, unknown>} */
    const args = {};
    for (const name of Object.keys(props)) if (given[name] !== undefined) args[name] = given[name];
    await action(entry.name, args, command);
  });
  return cmd;
}

/**
 * The generated rows for `sumo commands`: one per **reachable CLI-surfaced** capability. A
 * programmatic-/mcp-only capability is absent (surface model), and so is a capability whose name
 * collides with a built-in CLI verb (`reserved`) — the built-in wins, so listing it would advertise
 * an unreachable command. Use `reservedCliCollisions` to surface those as a diagnostic.
 *
 * @access public
 * @param {{ capabilities: () => Array<{ name: string, title?: string, plugin?: string, surfaces: string[], inputSchema?: object }> }} runtime - Runtime exposing the capability catalog.
 * @param {Set<string>} reserved - Built-in command names that cannot be generated from capabilities.
 * @returns {Array<{ command: string, plugin: string, title?: string, surfaces: string, hasSchema: boolean }>} Table rows for reachable CLI commands.
 */
export function capabilityRows(runtime, reserved = new Set()) {
  return runtime
    .capabilities()
    .filter((c) => c.surfaces.includes('cli') && !reserved.has(c.name))
    .map((c) => ({
      command: c.name, plugin: c.plugin ?? '', title: c.title, surfaces: c.surfaces.join(','), hasSchema: Boolean(c.inputSchema)
    }));
}

/**
 * Names of CLI-surfaced capabilities that collide with a built-in CLI verb and are therefore
 * unreachable via the CLI (the built-in wins). Surfaced as diagnostics by `sumo commands` so the
 * shadowing is honest, not silent. The capability is still reachable on its other surfaces.
 *
 * @access public
 * @param {{ capabilities: () => Array<{ name: string, surfaces: string[] }> }} runtime - Runtime exposing the capability catalog.
 * @param {Set<string>} reserved - Built-in command names that cannot be generated from capabilities.
 * @returns {string[]} List produced by `reservedCliCollisions`.
 */
export function reservedCliCollisions(runtime, reserved) {
  return runtime
    .capabilities()
    .filter((c) => c.surfaces.includes('cli') && reserved.has(c.name))
    .map((c) => c.name);
}
