/**
 * Package version read from the root manifest so every runtime surface reports the published version.
 *
 * @module sumo/version
 */

import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Published Sumo package version. */
export const VERSION = manifest.version;
