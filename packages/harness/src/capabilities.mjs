/**
 * First-class capabilities from the harness layer — projected onto CLI / MCP / programmatic
 * surfaces via the `sumo/capability` contract (spec 16).
 *
 * `harnesses` — machine-readable catalog of registered harness adapters with per-harness
 * availability status, declared providers, and version.
 * `models` — machine-readable model tier catalog per harness.
 *
 * @module sumo/harness/capabilities
 */

import { z } from 'zod';
import { create } from 'sumo/capability';
import { list, pick } from './models.mjs';

/**
 * @typedef {{ command: (capability: import('sumo/capability').CapabilityDef) => void }} HarnessCapabilityHost
 */

/**
 * Register harness capabilities onto the plugin runtime facade.
 * Must be called with a `sumo` facade that has access to the harness factories (after auto-registration).
 *
 * @access public
 * @param {HarnessCapabilityHost} sumo - Plugin runtime facade used to register capabilities.
 * @param {{ factories?: Map<string,Function>, buildCtx?: Function }} deps - Dependencies required by the operation.
 * @returns {void} Completes without producing a value.
 */
export function register(sumo, { factories = new Map(), buildCtx = () => ({}) } = {}) {
  sumo.command(create({
    name: 'harnesses',
    title: 'List Harnesses',
    description: 'List registered harness adapters with their availability status, declared providers, and version. ' +
      'Each harness is probed with a lightweight binary check (no spawn). ' +
      'Use the `harness` filter to check a specific adapter.',
    inputSchema: z.object({
      harness: z.string().optional().describe('Check only this harness id (e.g. "claude-code", "cursor", "codex")')
    }),
    outputSchema: z.array(z.object({
      id: z.string(),
      status: z.enum(['available', 'unavailable', 'unknown']),
      version: z.string().nullable().optional(),
      providers: z.array(z.string()).optional(),
      reason: z.string().optional()
    })),
    annotations: {
      readOnlyHint: true
    },
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Probe registered harness factories through their actual adapter availability checks.
     *
     * @access public
     * @param {{ harness?: string }} input - Validated input for the operation.
     * @returns {Promise<Array<{ id: string, status: string, version?: string|null, providers?: string[], reason?: string }>>} Promise that resolves with the list returned by `exec`.
     */
    async exec(/** @type {{ harness?: string }} */ input) {
      const ids = input.harness
        ? [input.harness]
        : [...factories.keys()];

      const results = await Promise.all(ids.map(async (id) => {
        const factory = factories.get(id);
        if (!factory) {
          return {
            id,
            status: 'unknown',
            reason: `no harness registered with id '${id}'`
          };
        }

        const adapter = factory(buildCtx(id, 'harness'));
        const probe = await adapter.available();
        const providers = adapter.can.providers;
        return {
          id,
          status: probe.status,
          version: probe.version,
          providers,
          reason: probe.reason
        };
      }));

      return results;
    }
  }));

  sumo.command(create({
    name: 'models',
    title: 'List Models',
    description: 'List registered harness models and derived model tier picks. ' +
      'Tiers are computed from each harness runtime model list.',
    inputSchema: z.object({
      harness: z.string().optional().describe('Check only this harness id (e.g. "claude-code", "cursor", "codex")')
    }),
    outputSchema: z.array(z.object({
      harness: z.string(),
      status: z.enum(['available', 'unavailable', 'unknown']),
      providers: z.array(z.string()).optional(),
      models: z.array(z.object({
        id: z.string()
      }).passthrough()),
      tiers: z.record(z.string(), z.string()),
      reason: z.string().optional()
    })),
    annotations: {
      readOnlyHint: true
    },
    surfaces: ['cli', 'mcp', 'programmatic'],
    /**
     * Return registered harness model lists through their actual adapter factories.
     *
     * @access public
     * @param {{ harness?: string }} input - Validated input for the operation.
     * @returns {Promise<Array<{ harness: string, status: string, providers?: string[], models: Array<object>, tiers: Record<string, string>, reason?: string }>>} Model lists and tiers.
     */
    async exec(/** @type {{ harness?: string }} */ input) {
      const ids = input.harness
        ? [input.harness]
        : [...factories.keys()];

      return Promise.all(ids.map(async (id) => {
        const factory = factories.get(id);
        if (!factory) {
          return {
            harness: id,
            status: 'unknown',
            models: [],
            tiers: {},
            reason: `no harness registered with id '${id}'`
          };
        }

        const adapter = factory(buildCtx(id, 'harness'));
        const providers = adapter.can.providers;
        const r = await list(adapter);
        return {
          harness: id,
          status: r.status,
          providers,
          models: r.models,
          tiers: pick(r.models),
          reason: r.reason
        };
      }));
    }
  }));
}
