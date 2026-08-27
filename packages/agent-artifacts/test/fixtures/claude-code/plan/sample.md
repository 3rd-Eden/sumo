# Build: Sumo config resolver (`sumo/config`, spec 06)

## Context

Sumo's storage + daemon + event-log layer is built, but the daemon still accepts a request `cwd`
without resolving `sumo.yml`. This task builds the config resolution layer as a standalone pure
function.

## Decisions carried into this build

- `--config <path>` composes: treated as the nearest config but still layers global + parents.

## Verification

- `node --test packages/config/test/*.test.mjs`
