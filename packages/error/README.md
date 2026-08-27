# `sumo/error`

One self-documenting, self-serializing error class for the whole system. Every `SumoError`:

- renders a **documentation link in its `.message`**, so a developer hitting it gets a path to a fix;
- carries the throw site (`package` / `method`), a stable `code`, and a content `reference`;
- **serializes itself completely** via `toJSON()` — custom fields and the full `cause` chain included
  — so the same rich object survives the daemon wire (`JSON.stringify` picks up `toJSON` automatically)
  and feeds diagnostics directly.

Doc links key on the `SUMO_*` **code** (`#error-sumo-no-daemon`), so they survive renames. Every code
has a matching entry in [`docs/errors.md`](../../docs/errors.md) (enforced by a coverage test).

## Usage

```js
import { SumoError } from 'sumo/error';

// a thrown error
throw new SumoError({
  name: 'db',
  method: 'connect',
  code: 'SUMO_NO_DAEMON',
  message: 'no sumo daemon at {sock} and autostart is disabled',
  vars: { sock }
});

// wrapping at a boundary — preserves the original as `cause`
try { await call(); }
catch (e) {
  throw SumoError.wrap(e, { name: 'cli', method: 'invoke', code: 'SUMO_DAEMON_CALL_FAILED',
                            message: 'command failed while talking to the daemon' });
}
```

The rendered message:

```
sumo/db(connect): no sumo daemon at /…/sumo.sock and autostart is disabled

For more information visit: https://github.com/3rd-Eden/sumo/blob/main/docs/errors.md#error-sumo-no-daemon
```

## API

| Export | Purpose |
|--------|---------|
| `SumoError` | the error class; `toJSON()`, static `from(json)` (wire reconstruct, idempotent), static `wrap(err, ctx)` (boundary wrap with `cause`) |
| `ErrorSchema` | zod contract for a serialized `SumoError` (superset of `sumo/config`'s `DiagnosticSchema`) |
| `docs({ code })` | resolve the documentation URL for an error code (`<docs>#error-<code>`) |

Every `SumoError` requires a `code`; it keys the documentation link and is the stable identifier
diagnostics and the daemon wire carry.

Required upstream license notices are collected in the repository's `THIRD_PARTY_NOTICES.md`.
