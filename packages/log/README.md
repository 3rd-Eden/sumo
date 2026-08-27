# `sumo/log`

Shared operational logging for Sumo packages. This package owns the one rotating file logger used for
error and runtime diagnostics that should be recorded without affecting behavior.

Imported as `sumo/log`.

## What it does

- Creates a shared `winston` logger on first use.
- Writes JSON logs under `~/.sumo/logs` (or `SUMO_HOME/logs`).
- Rotates daily with `winston-daily-rotate-file`.
- Treats logging as observational only: logging failures are swallowed.

## API

| Export | Purpose |
|--------|---------|
| `logger()` | Return the shared `winston` logger instance. |
| `logError(error, meta?)` | Log an error-like value plus optional structured metadata without letting logging failures escape. |

## Behavior

- Log directory: `<sumoHome()>/logs`
- Default level: `info`
- Override level: `SUMO_LOG_LEVEL`
- Filename pattern: `sumo-%DATE%.log`
- Rotation: daily, max `10m` per file, keep `14d`

## Usage

```js
import { logError, logger } from 'sumo/log';

logger().info('sumo started', { service: 'daemon' });

try {
  await run();
} catch (error) {
  logError(error, { service: 'daemon', method: 'run' });
}
```
