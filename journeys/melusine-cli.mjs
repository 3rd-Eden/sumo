#!/usr/bin/env node
// @ts-check
/**
 * Local Melusine CLI shim.
 *
 * The installed pnpm bin can resolve through a symlink path that prevents Melusine's own entrypoint
 * guard from firing. This file delegates to Melusine's CLI `main()` without owning any graph execution.
 *
 * @module journeys/melusine-cli
 */

// @ts-expect-error Melusine exports the CLI implementation as JavaScript without declarations.
import { main } from '../node_modules/melusine/src/cli.js';

process.exitCode = await main();
