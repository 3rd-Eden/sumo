# Sumo error reference

This page is written for the moment something breaks. Every error Sumo raises ends its message with a
link straight to its entry here:

```
sumo/db(open): no sumo daemon at /home/example/.sumo/kv.sock and autostart is disabled

For more information visit: https://github.com/3rd-Eden/sumo/blob/main/docs/errors.md#error-sumo-no-daemon
```

The first line is `package(method): what went wrong`. The link's `#error-...` fragment is the error's
stable **code** (`SUMO_NO_DAEMON` → `#error-sumo-no-daemon`); jump to that section for what it means, why
it happens, and exactly how to fix it — with a copy-pasteable example. The code never changes when code is
renamed or messages are reworded, so a bookmarked link keeps working.

## What these words mean (read once)

You do not need to know Sumo's internals to use this page, but a few terms recur:

- **Daemon** — a small background process Sumo starts on your machine. It owns the on-disk database and is
  the single point every other part of Sumo talks to over a local socket (a file like `~/.sumo/kv.sock`).
  If it is not running, most commands cannot read or write anything.
- **Harness** — a coding-agent CLI that Sumo drives or observes: Claude Code, Codex, Cursor, OpenCode.
- **Plugin** — an optional extension you enable in `sumo.yml`. In code a plugin is a function
  `export default function myPlugin(sumo, options) { … }` that calls verbs on `sumo` to register behavior.
- **Capability** — a named operation a plugin or harness declares it can perform.
- **Messenger** — an integration that posts/reads work items in an external medium (e.g. GitHub issues).
- **Result** — Sumo's way of reporting an *expected* failure: a value `{ ok: false, code, reason }` that is
  *returned*, not thrown. The same `SUMO_*` codes below are used for both thrown errors and Results.

Each entry also shows **Raised from** — the `package(method)` that produced it — so you know where in Sumo
the error originates. Examples are in collapsible blocks; click to expand.

---

## Configuration

<a id="error-sumo-config-not-found"></a>
### `SUMO_CONFIG_NOT_FOUND` — no configuration file was found

**Raised from:** `sumo/config(discover)`

**What happened:** Sumo looked for a `sumo.yml` (or `sumo.yaml`) and found none in the current directory or
any parent directory.

**Why it happens:** You are running outside a set-up project, or the file was deleted, renamed, or never
created.

**How to fix it:**
1. Check where you are — `pwd`. Sumo searches the current folder and walks upward toward `/`.
2. If this project should have config, create a `sumo.yml` at its root. A blank YAML file is valid.
3. If you meant to inherit config from a parent folder, run the command from inside that folder tree.

<details><summary>Example — create a minimal config at the project root</summary>

```sh
cd /path/to/your/project
touch sumo.yml                # blank config is valid; add settings later
sumo doctor                   # confirms config is now found
```
</details>

---

<a id="error-sumo-config-read"></a>
### `SUMO_CONFIG_READ` — the configuration file could not be read

**Raised from:** `sumo/config(discover)` (also harness install when reading an adapter's settings file)

**What happened:** Sumo found a config file (or a harness's settings JSON) but the OS refused to read it.

**Why it happens:** File permissions (owned by another user / not readable), or the path is not a regular
file (a directory, a broken symlink).

**How to fix it:**
1. The message names the file. Inspect it: `ls -l <file>`.
2. If permissions are wrong, make it readable by your user.
3. If the path is wrong, fix the setting that points at it and retry.

<details><summary>Example — inspect and repair access</summary>

```sh
ls -l ~/.sumo/sumo.yml        # who owns it, what mode?
chmod u+r ~/.sumo/sumo.yml    # grant your user read access
# if it is owned by root from an earlier sudo run:
sudo chown "$(whoami)" ~/.sumo/sumo.yml
```
</details>

---

<a id="error-sumo-config-parse"></a>
### `SUMO_CONFIG_PARSE` — the configuration file is not valid YAML

**Raised from:** `sumo/config(discover)`

**What happened:** The config file was read but is not parseable YAML.

**Why it happens:** A syntax mistake — wrong indentation, a tab where spaces are required, an unclosed quote
or bracket.

**How to fix it:**
1. Open the file at the line the message points to.
2. Validate it (your editor highlights YAML errors; or use any YAML linter).
3. Fix the usual culprits: tabs, misaligned nesting, an unterminated quote.

<details><summary>Example — a common mistake and its fix</summary>

```yaml
# ✗ invalid: value indented under the wrong key, and a tab before "default"
harness:
	default: claude-code

# ✓ valid: two spaces, consistent nesting
harness:
  default: claude-code
```
</details>

---

<a id="error-sumo-config-invalid"></a>
### `SUMO_CONFIG_INVALID` — the configuration is well-formed but has invalid values

**Raised from:** `sumo/config(resolve)` (also harness install when an adapter's JSON settings are not valid JSON and Sumo refuses to overwrite them)

**What happened:** The file parsed, but a value is not allowed — wrong type, unknown option, or out-of-range
number.

**Why it happens:** A setting got the wrong kind of value, or a key was typo'd.

**How to fix it:**
1. The message says which value failed and why. Open the file and correct it.
2. Cross-check the expected shape for that section.
3. Re-run `sumo doctor` to confirm it validates.

<details><summary>Example — wrong type vs. accepted value</summary>

```yaml
# ✗ invalid: scope must be one of "project" | "global", not a boolean
daemon:
  scope: true

# ✓ valid
daemon:
  scope: project
```
</details>

---

<a id="error-sumo-plugin-config-invalid"></a>
### `SUMO_PLUGIN_CONFIG_INVALID` — a plugin's settings are invalid

**Raised from:** `sumo/config(plugins)` / `sumo/plugin`

**What happened:** A plugin declares the shape of its own settings, and the values under `plugins.<name>` in
`sumo.yml` did not match. The plugin is skipped.

**Why it happens:** A missing required option, a typo'd key, or a wrong value type in that plugin's config
block.

**How to fix it:**
1. The message names the plugin and each invalid field.
2. Fix that `plugins.<name>:` block in `sumo.yml`.
3. Check the plugin's README for accepted options; re-run `sumo doctor`.

<details><summary>Example — correcting a plugin's config block</summary>

```yaml
# message: plugin "github" config is invalid: labels: Expected array, received string
plugins:
  github:
    labels: "bug"        # ✗ wrong type

# ✓ fixed
plugins:
  github:
    labels: ["bug"]
```
</details>

---

## Daemon and storage

<a id="error-sumo-no-daemon"></a>
### `SUMO_NO_DAEMON` — the background daemon is not running

**Raised from:** `sumo/db(open)`

**What happened:** A command needed the daemon but could not reach it, and automatic startup was turned off,
so it gave up instead of starting one.

**Why it happens:** The daemon was never started, it crashed, or auto-start was disabled (the environment
variable `SUMO_NO_AUTOSTART=1`, or an `autostart: false` option passed in code).

**How to fix it:**
1. Start it yourself, or re-run with auto-start enabled.
2. Check health with `sumo doctor`.
3. If it starts then dies immediately, see [`SUMO_DB_LOCKED`](#error-sumo-db-locked) and
   [`SUMO_INSECURE_PERMS`](#error-sumo-insecure-perms) — the two most common startup failures.

<details><summary>Example — start the daemon / re-enable auto-start</summary>

```sh
sumo daemon                   # start it explicitly in the background
sumo doctor                   # should now report the daemon "up"

# if a parent shell disabled auto-start, clear it and re-run your command:
unset SUMO_NO_AUTOSTART
```
</details>

---

<a id="error-sumo-db-locked"></a>
### `SUMO_DB_LOCKED` — another daemon already owns the database

**Raised from:** `sumo/db(start)`

**What happened:** A daemon tried to open the database, but another process already has it open. Only one
daemon may own a database directory at a time — this is intentional and protects your data.

**Why it happens:** A daemon is already running for this project (the normal case — you do not need a second
one), or a previous daemon did not shut down cleanly.

**How to fix it:**
1. Usually nothing to fix — a daemon is already running and your command can use it.
2. If you believe it is stale, find and stop that process, then retry.
3. Never delete the lock file by hand while a daemon is alive — stop the process instead.

<details><summary>Example — find and stop a stale daemon</summary>

```sh
sumo doctor                   # reports the running daemon, if visible
# otherwise locate the process holding the db directory named in the message:
pgrep -fl sumo                # list sumo processes
kill <pid>                    # stop the stale one, then retry your command
```
</details>

---

<a id="error-sumo-insecure-perms"></a>
### `SUMO_INSECURE_PERMS` — a private file could not be locked down

**Raised from:** `sumo/db(securePath)`

**What happened:** Sumo tried to restrict a file (its socket or database) to owner-only access (mode `0600`)
and the OS rejected the change. Sumo treats this as fatal rather than leave a world-readable file in place.

**Why it happens:** The file is on a filesystem that does not support Unix permissions (some network or
container-mounted volumes), or it is owned by a different user.

**How to fix it:**
1. The message names the file — check its location and ownership with `ls -l <file>`.
2. Point Sumo's home at a normal local path you own and retry.
3. If ownership is wrong, correct it.

<details><summary>Example — move Sumo's home to a local path</summary>

```sh
# if ~/.sumo is on a mounted/network volume, use a local one:
export SUMO_HOME="$HOME/.sumo-local"
sumo daemon
```
</details>

---

<a id="error-sumo-bad-message"></a>
### `SUMO_BAD_MESSAGE` — the daemon received a malformed request

**Raised from:** `sumo/db(control)`

**What happened:** A message on the daemon's control socket was not valid — not parseable JSON, or not the
expected request shape.

**Why it happens:** Almost always a version mismatch (a client and daemon from different Sumo versions), or a
non-Sumo program connected to the socket.

**How to fix it:**
1. Make sure every part of Sumo is the same version; restart the daemon after upgrading.
2. Confirm nothing other than Sumo connects to the socket path under `SUMO_HOME`.

<details><summary>Example — restart cleanly after an upgrade</summary>

```sh
pgrep -fl sumo && kill <pid>  # stop the old daemon
sumo daemon                   # start the upgraded one
```
</details>

---

<a id="error-sumo-bad-op"></a>
### `SUMO_BAD_OP` — the daemon was asked to do something it cannot

**Raised from:** `sumo/db(steer)` / `sumo/db(session)`

**What happened:** The daemon got a recognized message but an operation it does not handle in this
configuration. Most commonly: a plain storage daemon was asked for *steering* or *session* control, which
only a daemon with the orchestration runtime wired in can do.

**Why it happens:** A feature was used that needs the full runtime, but a bare storage daemon answered.

**How to fix it:**
1. Use the command/entry point that starts the full runtime (steering and session control are hosted by the
   project runtime, not a bare daemon).
2. If you are calling Sumo's API, target a runtime-hosting daemon. `sumo doctor` shows what the current
   daemon supports.

<details><summary>Example — check what the daemon supports</summary>

```sh
sumo doctor                   # shows daemon reachability and the hosted surfaces
```
</details>

---

<a id="error-sumo-bad-key-segment"></a>
### `SUMO_BAD_KEY_SEGMENT` — an internal database key was malformed

**Raised from:** `sumo/db(pad)`

**What happened:** Sumo tried to build a database key from a number that was not a non-negative integer, or
that was too large for its fixed-width slot.

**Why it happens:** This is an internal invariant — a bug in the code that built the key, not anything you
configured or typed.

**How to fix it:** This should not occur in normal use. Note the value in the message and what you were doing,
and report it.

<details><summary>Example — what to include in a report</summary>

```
- the full error message (it contains the offending value)
- the command or API call you ran
- sumo --version  (and the harness, if relevant)
```
</details>

---

<a id="error-sumo-internal"></a>
### `SUMO_INTERNAL` — an unexpected internal error

**Raised from:** `sumo/db` / `sumo/orchestrator` / wherever an unanticipated failure is wrapped

**What happened:** Something failed in a way Sumo did not anticipate, so it reported a generic internal
error. The real cause is attached.

**Why it happens:** A bug, or an unusual environment condition no specific code covers yet.

**How to fix it:**
1. Read the `caused by:` detail — it usually names the real problem (a missing file, a network error, a
   permissions issue).
2. Gather environment health with `sumo doctor`.
3. If the cause is not actionable, report it with the full message including the `caused by:` chain.

<details><summary>Example — find the real cause</summary>

```sh
# the cause chain is in the message; in JSON output it is the nested "cause":
sumo <your-command> --json 2>&1 | tail -n 40
# or read err.cause / err.toJSON().cause if you caught it in code
```
</details>

---

## Plugins

<a id="error-sumo-invalid-plugin"></a>
### `SUMO_INVALID_PLUGIN` — a plugin could not be identified or loaded

**Raised from:** `sumo/plugin(use)` / `sumo/plugin(load)`

**What happened:** Sumo was asked to use a plugin but the argument did not name one it could resolve: an
empty specifier, an anonymous function with no name, an object missing a name, an unexpected argument type,
or a module with no default-exported plugin function.

**Why it happens:** A mistake in how the plugin was registered — in `sumo.yml`'s `use:` list or in a
`sumo.use(...)` call.

**How to fix it:** Give the plugin a name (a named function, `{ name, fn }`, or a module specifier string),
and make sure a module plugin's `export default` is the plugin function.

<details><summary>Example — name an anonymous plugin</summary>

```js
// ✗ anonymous arrow → Sumo cannot derive an id
sumo.use((sumo) => { /* … */ });

// ✓ named function
sumo.use(function metrics(sumo) { /* … */ });

// ✓ or pass an explicit name
sumo.use({ name: 'metrics', fn: (sumo) => { /* … */ } });
```
</details>

---

<a id="error-sumo-reserved-prefix"></a>
### `SUMO_RESERVED_PREFIX` — a plugin id uses a reserved name

**Raised from:** `sumo/plugin(use)`

**What happened:** A plugin tried to register under an id beginning with `__sumo_`, which Sumo reserves for
its own internal use.

**Why it happens:** The plugin's name starts with the reserved prefix.

**How to fix it:** Rename the plugin so its id does not start with `__sumo_`.

<details><summary>Example — rename the plugin</summary>

```js
// ✗  function __sumo_metrics(sumo) {}
// ✓
sumo.use(function metrics(sumo) { /* … */ });
```
</details>

---

<a id="error-sumo-duplicate-registration"></a>
### `SUMO_DUPLICATE_REGISTRATION` — a name was registered twice

**Raised from:** `sumo/plugin(use | command | skill | provider | extendFacade | wrapRun)`

**What happened:** Two things tried to claim the same name — two plugins with the same id, two commands, two
skills, two providers (`harness`/`messenger`), or two facade verbs / run hooks. Names must be unique.

**Why it happens:** The same plugin is enabled twice, or two plugins pick the same name. The message names the
duplicated id (e.g. `github`).

**How to fix it:**
1. Find the two registrations of that name.
2. Remove the duplicate, or rename one — for two independent plugins, choose a more specific name.

<details><summary>Example — the `'github'` collision in scenario terms</summary>

```js
// Two plugins both register a messenger called 'github':
sumo.messenger('github', (mctx) => new GitHubMessenger(mctx));   // built-in / other plugin
sumo.messenger('github', (mctx) => new MyGitHub(mctx));          // ✗ yours collides

// ✓ give yours a unique, specific name:
sumo.messenger('github-acme', (mctx) => new MyGitHub(mctx));
```
If instead the *same* plugin is listed twice, remove the duplicate entry from `use:` in `sumo.yml`.
</details>

---

<a id="error-sumo-invalid-provider"></a>
### `SUMO_INVALID_PROVIDER` — a provider was registered incorrectly

**Raised from:** `sumo/plugin(provider)`

**What happened:** A `harness`/`messenger` provider was registered with a bad argument: a missing/empty name,
or an implementation that is not a factory function.

**Why it happens:** A coding mistake in the registration call. The factory must be a *function* that returns
the implementation object.

**How to fix it:** Pass a non-empty string name and a factory function.

<details><summary>Example — name + factory function</summary>

```js
class MyHarness extends Harness {
  id = 'my-harness';
  async write(action) { /* send action to the real harness medium */ }
}

// ✗ passing the adapter instance directly (not a factory)
sumo.harness('my-harness', new MyHarness());

// ✓ a factory function that receives context and returns the implementation
sumo.harness('my-harness', (hctx) => new MyHarness(hctx));
```
</details>

---

<a id="error-sumo-provider-phase"></a>
### `SUMO_PROVIDER_PHASE` — a provider was registered at the wrong time

**Raised from:** `sumo/plugin(provider)`

**What happened:** A provider was registered outside the plugin's activation phase. Providers may only be
registered while the plugin function is running.

**Why it happens:** The `harness`/`messenger` call ran later — from inside an event handler or a callback
that fires after activation.

**How to fix it:** Register providers in the plugin body, not in a deferred callback.

<details><summary>Example — register during activation, not later</summary>

```js
export default function myHarness(sumo) {
  // ✗ deferred — runs after activation
  sumo.on('session.start', () => sumo.harness('late', factory));

  // ✓ register immediately in the plugin body
  sumo.harness('mine', (hctx) => new MyHarness(hctx));
}
```
</details>

---

<a id="error-sumo-harness-no-run"></a>
### `SUMO_HARNESS_NO_RUN` — the selected harness cannot start a session

**Raised from:** `sumo/plugin(run)`

**What happened:** Sumo tried to start a session with a harness whose adapter does not implement
`run(prompt, opts)`.

**Why it happens:** The harness is observe-only (it ingests transcripts but cannot launch the agent), or a
custom adapter is incomplete.

**How to fix it:** Choose a harness that can launch sessions, or implement `run` on the custom adapter.
`sumo doctor` lists harnesses and what they support.

<details><summary>Example — a launchable harness factory implements run</summary>

```js
class MyHarness extends Harness {
  id = 'mine';
  async write(action) { /* send action to the real AI coding harness */ }
}

sumo.harness('mine', (hctx) => new MyHarness(hctx));
```
</details>

---

<a id="error-sumo-facade-invalid"></a>
### `SUMO_FACADE_INVALID` — an invalid attempt to extend the runtime's verb surface

**Raised from:** `sumo/plugin(extendFacade)`

**What happened:** Code tried to add a verb to the `sumo` facade incorrectly — after `start()`, with a
non-function handler, or with a name that collides with a built-in verb (`use`, `on`, `before`, `command`,
`skill`, `run`, `store`, `install`, `harness`, `messenger`, `destroy`).

**Why it happens:** A privileged extension (typically the orchestrator) called `extendFacade` at the wrong
time, with the wrong handler type, or reused a built-in name. (A name already added by another extension
raises [`SUMO_DUPLICATE_REGISTRATION`](#error-sumo-duplicate-registration) instead.)

**How to fix it:** Call `extendFacade` before `start()`, pass a function, and choose a non-built-in verb name.

<details><summary>Example — correct extendFacade usage</summary>

```js
const rt = plugin({ /* … */ });
rt.extendFacade('surface', (pluginId, event) => ({ ok: true }));   // ✓ before start, function, free name
await rt.start();
// ✗ rt.extendFacade('run', fn)        → collides with a built-in verb
// ✗ rt.extendFacade('surface', fn)    → after another start()/registration
```
</details>

---

<a id="error-sumo-wraprun-invalid"></a>
### `SUMO_WRAPRUN_INVALID` — an invalid attempt to wrap session launches

**Raised from:** `sumo/plugin(wrapRun)`

**What happened:** Code tried to install a "run wrapper" (which intercepts how sessions launch) incorrectly —
after `start()`, or with a non-function handler. (A wrapper already installed raises
[`SUMO_DUPLICATE_REGISTRATION`](#error-sumo-duplicate-registration).)

**Why it happens:** `wrapRun` was called at the wrong time or with the wrong argument type.

**How to fix it:** Call `wrapRun` before `start()` and pass a function.

<details><summary>Example — correct wrapRun signature</summary>

```js
const rt = plugin({ /* … */ });
rt.wrapRun((prompt, opts, baseRun, pluginId) => baseRun(prompt, opts));  // ✓ before start
await rt.start();
```
</details>

---

<a id="error-sumo-plugin-load"></a>
### `SUMO_PLUGIN_LOAD` — a plugin module failed to import

**Raised from:** `sumo/plugin` (activation)

**What happened:** Sumo tried to import a plugin by module specifier and the import threw. That plugin is
skipped; the rest continue.

**Why it happens:** The package is not installed, the specifier is misspelled, or the module throws on import.

**How to fix it:** The message names the specifier and the underlying import error.

<details><summary>Example — install or fix the specifier</summary>

```sh
pnpm add sumo-plugin-foo      # if it was simply not installed
```
```yaml
# fix a typo'd specifier in sumo.yml
use:
  - sumo-plugin-foo           # ✓  (was: sumo-plugn-foo)
```
</details>

---

<a id="error-sumo-plugin-decl-invalid"></a>
### `SUMO_PLUGIN_DECL_INVALID` — a plugin's declaration is malformed

**Raised from:** `sumo/plugin` (activation)

**What happened:** A plugin's static `.sumo` marker (its name, dependencies, config schema) is not a valid
shape, or its declared name is unusable, duplicated, or reserved.

**Why it happens:** A mistake in how the plugin author wrote the `.sumo` marker on the plugin function.

**How to fix it:** If you authored it, correct the marker; otherwise report it to the author (the plugin is
skipped meanwhile).

<details><summary>Example — a correct `.sumo` marker</summary>

```js
export default function github(sumo, options) { /* … */ }
github.sumo = {
  name: 'github',                 // a usable, unique, non-reserved id
  plugins: [],                    // declared plugin dependencies (optional)
  config: z.object({ /* … */ })   // zod schema for plugins.github (optional)
};
```
</details>

<a id="error-sumo-plugin-dep-missing"></a>
### `SUMO_PLUGIN_DEP_MISSING` — a plugin requires another that is absent

**Raised from:** `sumo/plugin` (activation)

**What happened:** A plugin declared it depends on other plugins, and at least one is not enabled or did not
load. The dependent plugin is skipped.

**Why it happens:** A required plugin is missing from `use:`, or it failed to load itself.

**How to fix it:** Add the missing plugin(s) to `use:`. If a listed one is still reported missing, it failed
to load — fix its [`SUMO_PLUGIN_LOAD`](#error-sumo-plugin-load) /
[`SUMO_PLUGIN_CONFIG_INVALID`](#error-sumo-plugin-config-invalid) first.

<details><summary>Example — add the dependency</summary>

```yaml
# message: plugin 'handoff' requires missing/unavailable plugin(s): github
use:
  - github          # ✓ add the dependency it needs
  - handoff
```
</details>

---

<a id="error-sumo-plugin-cycle"></a>
### `SUMO_PLUGIN_CYCLE` — plugins depend on each other in a loop

**Raised from:** `sumo/plugin` (activation)

**What happened:** Two or more plugins declare dependencies that form a cycle (A needs B, B needs A). Sumo
activates them in best-effort order and warns.

**Why it happens:** A circular dependency among declared plugin dependencies.

**How to fix it:** Break the loop — remove one direction, or extract the shared need into a third plugin both
depend on.

<details><summary>Example — break the cycle</summary>

```js
// ✗ a.sumo = { plugins: ['b'] };  b.sumo = { plugins: ['a'] };
// ✓ extract shared logic into 'core' and have both depend on it instead:
a.sumo = { name: 'a', plugins: ['core'] };
b.sumo = { name: 'b', plugins: ['core'] };
```
</details>

---

<a id="error-sumo-plugin-activate"></a>
### `SUMO_PLUGIN_ACTIVATE` — a plugin threw while activating

**Raised from:** `sumo/plugin` (activation)

**What happened:** A plugin's function threw during setup. Everything it had registered so far is rolled back;
the rest continue.

**Why it happens:** A bug in the plugin's activation code, or a precondition it needs is missing (config, a
resource).

**How to fix it:** The message includes the plugin's underlying error — address that. For a third-party
plugin, report it and remove it from `use:` to unblock the rest.

<details><summary>Example — guard a precondition instead of throwing blindly</summary>

```js
export default function deploy(sumo, options) {
  if (!options?.token) {
    // surface a clear, recoverable reason rather than an opaque throw
    throw new Error('deploy plugin requires plugins.deploy.token in sumo.yml');
  }
  /* … */
}
```
</details>

---

<a id="error-sumo-queue-backpressure"></a>
### `SUMO_QUEUE_BACKPRESSURE` — events arrive faster than they are handled (warning)

**Raised from:** `sumo/plugin` (event delivery)

**What happened:** The event-delivery queue grew past a soft limit because observers process events more
slowly than they are produced. This is a warning, not a hard failure.

**Why it happens:** A slow `on(...)` handler doing heavy or blocking work is falling behind a burst.

**How to fix it:** Make slow handlers faster or offload heavy work; if the burst is transient, the warning is
safe to ignore (the queue drains once handlers catch up).

<details><summary>Example — offload heavy work out of the handler</summary>

```js
// ✗ blocks the delivery loop on every event
sumo.on('session.tool', async (e) => { await expensiveIndex(e); });

// ✓ enqueue and process in the background so delivery keeps draining
const work = [];
sumo.on('session.tool', (e) => { work.push(e); });   // returns immediately
setInterval(() => { const batch = work.splice(0); if (batch.length) expensiveIndex(batch); }, 1000);
```
</details>

---

<a id="error-sumo-no-command"></a>
### `SUMO_NO_COMMAND` — no capability command is registered with that name

**Raised from:** `sumo/plugin(invoke)`

**What happened:** Code tried to invoke a capability command that no plugin or built-in package registered.

**Why it happens:** A typo, a plugin that failed to activate, or a command requested through the wrong
runtime.

**How to fix it:** List capabilities for the active runtime, copy the exact command name, and check plugin
diagnostics if the command should exist.

<details><summary>Example — inspect available commands</summary>

```sh
sumo capabilities             # CLI-visible capabilities
sumo doctor                   # plugin diagnostics if a capability is missing
```
</details>

---

<a id="error-sumo-no-skill"></a>
### `SUMO_NO_SKILL` — no skill is registered with that name

**Raised from:** `sumo/plugin(skill.run)`

**What happened:** Code requested a skill that the active runtime did not register.

**Why it happens:** The name is misspelled, or the plugin that provides the skill did not activate.

**How to fix it:** Use the exact registered skill name and inspect plugin diagnostics when the provider is missing.

---

<a id="error-sumo-skill-failed"></a>
### `SUMO_SKILL_FAILED` — a registered skill failed while running

**Raised from:** `sumo/plugin(skill.run)`

**What happened:** The skill callback threw instead of returning a value or a shared `Result`.

**Why it happens:** The skill encountered an operational failure that it did not convert to a `Result`.

**How to fix it:** Read the reported reason, correct the underlying failure, and retry the skill.

---

<a id="error-sumo-command-input-invalid"></a>
### `SUMO_COMMAND_INPUT_INVALID` — command input failed validation

**Raised from:** `sumo/plugin(invoke)`

**What happened:** The command exists, but the arguments did not match its declared input schema.

**Why it happens:** A required field is missing, a value has the wrong type, or a field is outside the schema
the command declared.

**How to fix it:** Read the validation message, correct the input, and retry.

<details><summary>Example — pass the expected argument type</summary>

```js
// if the command declares z.object({ n: z.number() })
await runtime.invoke('square', { n: 4 });       // ✓
await runtime.invoke('square', { n: '4' });     // ✗ SUMO_COMMAND_INPUT_INVALID
```
</details>

---

<a id="error-sumo-surface-unsupported"></a>
### `SUMO_SURFACE_UNSUPPORTED` — a command is not available on this surface

**Raised from:** `sumo/plugin(invoke)`

**What happened:** A capability was invoked through a surface it did not declare, such as calling a
programmatic-only command through MCP or the CLI.

**Why it happens:** Capabilities explicitly declare where they can appear. Sumo gates unsupported surfaces
instead of exposing commands where they cannot behave correctly.

**How to fix it:** Invoke the command through one of its declared surfaces, or update the command definition
if it is safe to expose there.

<details><summary>Example — declare a surface intentionally</summary>

```js
sumo.command(create({
  name: 'internal-sync',
  surfaces: ['programmatic'],    // not callable from CLI/MCP
  exec: async () => ({ ok: true })
}));
```
</details>

---

<a id="error-sumo-no-interaction"></a>
### `SUMO_NO_INTERACTION` — the current surface cannot prompt the user

**Raised from:** `sumo/plugin(ctx.ask)`

**What happened:** A command or handler asked for interactive user input, but the current surface did not
provide an asker.

**Why it happens:** Headless surfaces such as MCP or programmatic invocation may not have a user prompt
channel.

**How to fix it:** Provide all required input up front, or call the command from an interactive surface that
injects an asker.

<details><summary>Example — avoid prompting on headless surfaces</summary>

```js
const r = await ctx.ask('Approve?');
if (!r.ok && r.code === 'SUMO_NO_INTERACTION') {
  return { ok: false, reason: 'approval required' };
}
```
</details>

---

## Capabilities

<a id="error-sumo-capability-invalid"></a>
### `SUMO_CAPABILITY_INVALID` — a capability definition is invalid

**Raised from:** `sumo/capability(create)`

**What happened:** A capability was defined with a shape that failed validation.

**Why it happens:** A missing or wrongly-typed field in a `create({ … })` definition.

**How to fix it:** The message lists the validation issues; match the expected shape.

<details><summary>Example — a complete, valid capability</summary>

```js
import { create } from 'sumo/capability';
import { z } from 'zod';

sumo.command(create({
  name: 'greet',
  title: 'Greet',
  description: 'say hello',
  inputSchema: z.object({ who: z.string() }),
  outputSchema: z.object({ hello: z.string() }),
  exec: (input) => ({ hello: input.who })
}));
```
</details>

---

<a id="error-sumo-no-harness"></a>
### `SUMO_NO_HARNESS` — no usable coding harness is available

**Raised from:** `sumo/plugin(run)`

**What happened:** `sumo.run(...)` needed a coding-agent harness, but Sumo could not select one. This can
mean no harness was registered, the requested harness id was not registered, or every candidate reported
`available().status === 'unavailable'`.

**Why it happens:** The configured default is missing, unauthenticated, exhausted, or points at a binary
that is not an automation harness. For Cursor specifically, the desktop `cursor` launcher is rejected so
Sumo does not open the GUI; use `agent` or `cursor-agent` instead. When `opts.resume` is set, Sumo does
not cross-fallback because native resume ids are harness-specific.

**How to fix it:**
1. Run `sumo doctor` to see registered harnesses and their availability reasons.
2. Install or authenticate at least one supported harness CLI.
3. Configure `harness.default` and, when multiple harnesses are acceptable, `harness.fallback`.
4. For Cursor, make sure `harness.cursor.bin` points to `agent` or `cursor-agent`,
   not the desktop `cursor` executable.

<details><summary>Example — configure an availability-aware fallback chain</summary>

```yaml
harness:
  default: claude-code
  fallback:
    - codex
    - cursor
```

```sh
sumo doctor                  # shows which candidate is selected or why each is unavailable
```
</details>

---

<a id="error-sumo-cap-unsupported"></a>
### `SUMO_CAP_UNSUPPORTED` — this adapter does not support the requested operation

**Raised from:** `sumo/orchestrator` (and any adapter whose `can` reports the op unsupported)

**What happened:** An operation was requested, but the adapter (harness or messenger) declared it cannot do
it. This is honest capability reporting, not a bug — e.g. asking Codex to inject a `key`stroke or `capture`
its screen, which it has no interactive terminal to do (Codex runs over a JSON protocol, not a TTY).

**Why it happens:** Harnesses genuinely differ in what they expose, and Sumo declares each adapter's
capabilities rather than faking parity. Capability also depends on *how* the session runs (interactive vs
piped, tmux available or not), so the same harness may support an op in one mode and not another.

**How to fix it:**
1. Treat the failed `Result` as a signal and branch on it, rather than assuming the op succeeded.
2. Use an operation the adapter supports, or a harness/messenger that supports the one you need.
3. `sumo doctor` shows the configured adapters and what they support.

<details><summary>Example — branch on the result instead of assuming success</summary>

```js
const r = await session.control(id, 'key', { name: 'Escape' });   // inject a keystroke
if (!r.ok && r.code === 'SUMO_CAP_UNSUPPORTED') {
  // e.g. Codex has no TTY to receive keys — send text over stdin instead (an op it does support)
  await session.control(id, 'send', { text: 'stop\n' });
}
```
The right fallback depends on the adapter: the `send` above works where stdin injection is supported,
but Cursor cannot inject stdin while Codex cannot send keys. Run
`sumo doctor` (or read the adapter's declared capabilities) to confirm which operations the *active*
harness/messenger supports before relying on a specific fallback — support varies per adapter.
</details>

---

<a id="error-sumo-unsupported"></a>
### `SUMO_UNSUPPORTED` — the requested action is not available here

**Raised from:** `sumo/cli`

**What happened:** A command was asked to do something it does not support in this context — e.g. installing
or uninstalling hooks for a harness that has no hook installer.

**Why it happens:** The named target (often a harness) is outside the set this command handles. The message
lists the supported options.

**How to fix it:** Pick one of the supported targets, or a different command.

<details><summary>Example — use a supported harness</summary>

```sh
# message: hook install for 'foo' is not supported (one of: claude-code, codex, cursor)
sumo install claude-code      # ✓ a supported target
```
</details>

---

<a id="error-sumo-install-source-missing"></a>
### `SUMO_INSTALL_SOURCE_MISSING` — an install source could not be found

**Raised from:** `sumo/cli(install)`

**What happened:** Project setup requested an install source, such as a skill source file, but the expected file
or directory was not present.

**Why it happens:** The plugin or project config points at a missing local path, or a plugin package is
incomplete.

**How to fix it:** Check the path named in the diagnostic, restore the missing source, or remove the install
entry that references it.

---

<a id="error-sumo-install-drift"></a>
### `SUMO_INSTALL_DRIFT` — installed project wiring is missing or changed

**Raised from:** `sumo/cli(install)`

**What happened:** `sumo doctor` found that expected Sumo-owned hook or project setup wiring is absent, unreadable,
or no longer contains Sumo's ownership marker.

**Why it happens:** A harness config was edited manually, a tool rewrote the file, or setup was only partially
installed.

**How to fix it:** Re-run `sumo install --yes` for the project, or run the harness-specific install command named
by the diagnostic.

---

## Harnesses and adapters

<a id="error-sumo-not-implemented"></a>
### `SUMO_NOT_IMPLEMENTED` — a required adapter method is missing

**Raised from:** `sumo/harness(write | Transport.*)` / `sumo/messenger(work | say | mark)`

**What happened:** A base adapter method a concrete adapter must provide was called but never implemented —
an abstract transport method, a harness `write(action)`, or a messenger's `work` / `say` / `mark`.

**Why it happens:** A custom harness or messenger adapter is incomplete, or a built-in adapter is being used
outside its supported operations.

**How to fix it:** If you wrote the adapter, implement the method named in the message. If it is built-in,
report it with the message and what you were doing.

<details><summary>Example — implement the missing messenger method</summary>

```js
class MyMessenger extends Messenger {
  id = 'mine';
  async *work() { /* yield work items */ }              // required
  async say(ref, text) { /* post a comment */ }         // implement what the message names
  async mark(ref, who) { /* claim/label the item */ }
}

sumo.messenger('mine', (mctx) => new MyMessenger(mctx));
```
</details>

---

<a id="error-sumo-no-parser"></a>
### `SUMO_NO_PARSER` — no transcript parser for this harness

**Raised from:** `sumo/harness(transcript)` / `sumo/agent-artifacts(parser)`

**What happened:** Sumo needed to read a harness's transcript (its conversation log) but no parser is
registered for that harness.

**Why it happens:** The harness id is unknown to the transcript layer, or a parser that should be registered
was not.

**How to fix it:** Confirm the harness id in the message is one Sumo supports (Claude Code, Codex, Cursor,
OpenCode). If it is, this indicates a wiring problem — report it with the harness id.

<details><summary>Example — confirm the harness id</summary>

```sh
sumo doctor                   # lists configured harnesses and their ids
# the id in the message must be one of: claude-code, codex, cursor, opencode
```
</details>

---

<a id="error-sumo-no-transport"></a>
### `SUMO_NO_TRANSPORT` — the harness has no active connection

**Raised from:** `sumo/harness(transport)`

**What happened:** An operation needed the live connection to a running harness process, but none exists on
this harness.

**Why it happens:** The action was attempted before the session started, or after it ended.

**How to fix it:** Start (or restart) the session before issuing the action, and make sure it is still live.

<details><summary>Example — confirm the session is live first</summary>

```sh
sumo list                     # is the session still running?
# act on a live session id; if it ended, start a new one before sending input
```
</details>

---

<a id="error-sumo-io"></a>
### `SUMO_IO` — an agent artifact file could not be read

**Raised from:** `sumo/agent-artifacts`

**What happened:** Sumo tried to read a local artifact file, such as a plan or harness config snapshot, and
the OS read failed.

**Why it happens:** The file path is wrong, the file was deleted between discovery and read, or permissions
prevent access.

**How to fix it:** Check the path in the message, repair permissions or configuration, and retry.

<details><summary>Example — inspect the file Sumo tried to read</summary>

```sh
ls -l <path-from-the-error>
chmod u+r <path-from-the-error>     # if it exists but is not readable by you
```
</details>

---

<a id="error-sumo-spawn-failed"></a>
### `SUMO_SPAWN_FAILED` — the harness process could not be started or connected

**Raised from:** `sumo/harness(CodexAppServer.connect)` and other harness launch paths

**What happened:** Sumo tried to launch or attach to a harness (for Codex: its initialize / thread start /
thread resume handshake) and it failed or returned an unusable response.

**Why it happens:** The harness CLI is not installed or not on `PATH`, is the wrong version, is not
authenticated, or the thread/session being **resumed** no longer exists (`thread not found`).

**How to fix it:**
1. Confirm the harness CLI is installed and runs on its own.
2. Make sure it is logged in / authenticated.
3. The message includes the harness's own reason. For a failed *resume*, start a fresh session instead of
   resuming a stale one.

<details><summary>Example — verify the harness, then start fresh on a dead thread</summary>

```sh
codex --version               # installed and on PATH?
codex login                   # authenticated?
# "thread/resume failed: thread not found" → the old thread is gone; do not resume it.
# Re-run the command WITHOUT the resume option/id so a new session is created.
```
</details>

---

<a id="error-sumo-backend-unavailable"></a>
### `SUMO_BACKEND_UNAVAILABLE` — the harness backend cannot be used

**Raised from:** `sumo/harness(classify)` / `sumo/harness(probe)`

**What happened:** Sumo looked for the harness CLI binary (e.g. `claude`, `codex`, `agent`) on `PATH`
and could not find it, found it but it is not executable, or rejected the configured command because it
is not an automation backend.

**Why it happens:** The harness CLI is not installed. On macOS/Linux the executable bit may be missing.
For Cursor, `cursor` is the desktop launcher and is intentionally unavailable for automation because it
opens the GUI; Sumo only auto-discovers `agent` or `cursor-agent`.

**How to fix it:**
1. Install the harness CLI by following its official documentation.
2. Confirm the binary is on your `PATH`: `which claude` / `which codex` / `which agent`.
3. If the binary exists but is not executable: `chmod +x <path>`.
4. For Cursor, configure `harness.cursor.bin: agent` / `cursor-agent`;
   do not point Sumo at the desktop `cursor` launcher.
5. Re-run `sumo doctor` to confirm it is now reachable.

<details><summary>Example — verify the binary, then install if missing</summary>

```sh
which claude || echo "not on PATH"
# Install from https://docs.anthropic.com/en/docs/claude-code/getting-started
npm install -g @anthropic-ai/claude-code
sumo doctor            # should now report claude-code available
```
</details>

<details><summary>Example — Cursor must use the agent CLI, not the desktop launcher</summary>

```sh
which agent || which cursor-agent
cat > sumo.yml <<'YAML'
harness:
  cursor:
    bin: agent
YAML
sumo doctor            # should report cursor available, or show the agent CLI's real reason
```
</details>

---

<a id="error-sumo-auth-required"></a>
### `SUMO_AUTH_REQUIRED` — the harness requires authentication

**Raised from:** `sumo/harness(classify)`

**What happened:** The harness CLI is installed but is not authenticated. It reported a "not logged in",
"invalid API key", or similar credential error when Sumo tried to use it.

**Why it happens:** You have not logged in to the harness, the API key is missing or expired, or the
credential stored by the CLI has been revoked.

**How to fix it:**
1. Follow the harness's own login / API-key instructions.
2. Set the required environment variable if the harness uses one (e.g. `ANTHROPIC_API_KEY`).
3. Re-run `sumo doctor` to confirm authentication is now valid.

<details><summary>Example — authenticate each harness</summary>

```sh
claude login                    # Claude Code
codex login                     # Codex
# For API-key–based harnesses, set the variable before running sumo:
export ANTHROPIC_API_KEY="sk-ant-..."
```
</details>

---

<a id="error-sumo-budget-exhausted"></a>
### `SUMO_BUDGET_EXHAUSTED` — the API budget or credits are exhausted

**Raised from:** `sumo/harness(classify)`

**What happened:** The harness reported that the account's API credits, billing limit, or subscription
budget has been reached. The harness cannot process any more requests until the balance is topped up
or the billing period resets.

**Why it happens:** Your API account ran out of credits, hit a hard billing cap, or exhausted a
pre-paid plan. This differs from rate limiting (`SUMO_RATE_LIMITED`) which resets automatically.

**How to fix it:**
1. Check your account balance or billing dashboard for the affected provider.
2. Top up credits or upgrade your plan.
3. If auto-failover is enabled, Sumo will route to a different harness automatically — check
   `sumo doctor` for an available alternative.

<details><summary>Example — check balance and configure a fallback harness</summary>

```sh
# Top up credits in the provider's dashboard, then:
sumo doctor                     # confirm the harness is available again
# Or configure a fallback in sumo.yml:
# harness:
#   default: claude-code
#   fallback: [cursor, codex]
```
</details>

---

<a id="error-sumo-rate-limited"></a>
### `SUMO_RATE_LIMITED` — the API rate limit was exceeded

**Raised from:** `sumo/harness(classify)` / `sumo/orchestrator(guards)`

**What happened:** The harness (or Sumo's own spawn-rate guard) hit a rate limit. Unlike
`SUMO_BUDGET_EXHAUSTED`, this is transient — the limit will reset on its own.

**Why it happens:** Too many API requests in a short window, or Sumo's internal spawn-rate guard
fired (too many sessions started in the guard's configured window).

**How to fix it:**
1. Wait for the rate limit to reset (the harness usually prints the reset time).
2. If it is Sumo's own guard, reduce the spawn rate or increase the rate window in `sumo.yml`.
3. If auto-failover is enabled, Sumo will route to a different harness in the interim.

<details><summary>Example — adjust Sumo's spawn-rate guard</summary>

```yaml
# sumo.yml — increase the rate window if spawning many agents
orchestrator:
  guards:
    rate:
      max: 10
      windowMs: 60000
```
</details>

---

<a id="error-sumo-model-not-found"></a>
### `SUMO_MODEL_NOT_FOUND` — the requested model is not available

**Raised from:** `sumo/harness(classify)`

**What happened:** The harness rejected the `model` value in your config because the model name is
invalid, not available on your subscription, or does not exist.

**Why it happens:** A typo in the model name, a model that was renamed or discontinued, or a model
not available on your current plan.

**How to fix it:**
1. Check the harness's documentation for valid model names.
2. Update `harness.<id>.model` in `sumo.yml` with a correct name.
3. Or remove the `model` override to let the harness use its default.

<details><summary>Example — correct the model name</summary>

```yaml
# sumo.yml — use a valid model name for the harness
harness:
  claude-code:
    model: claude-sonnet-4-5    # ✓ valid model
  codex:
    model: codex-mini-latest    # ✓ valid model
```
</details>

---

<a id="error-sumo-overloaded"></a>
### `SUMO_OVERLOADED` — the backend service is temporarily overloaded

**Raised from:** `sumo/harness(classify)`

**What happened:** The harness's backend service is temporarily overloaded or unavailable. The
harness returned a "service unavailable" or similar transient error.

**Why it happens:** The provider is experiencing high load or a partial outage. This usually resolves
on its own within minutes.

**How to fix it:**
1. Wait a minute and retry — overload conditions are typically transient.
2. If auto-failover is enabled, Sumo will route to a different harness automatically.
3. Check the provider's status page if the issue persists.

<details><summary>Example — check provider status</summary>

```sh
# Check provider status pages, then retry:
sumo run "<prompt>"             # Sumo will failover automatically if another harness is available
```
</details>

---

<a id="error-sumo-verify-failed"></a>
### `SUMO_VERIFY_FAILED` — a session did not reach the expected state in time

**Raised from:** `sumo/session`

**What happened:** Sumo waited for a launched session to reach a terminal state (or to produce an expected
number of assistant turns) and the timeout elapsed first; or no native harness id was recorded for the
session.

**Why it happens:** The agent is taking longer than allotted, it stalled, or the session never fully started.

**How to fix it:**
1. Increase the timeout if the work legitimately takes longer.
2. Check whether the agent stalled or is waiting on input.
3. If no native id was recorded, the session failed to start — look for an earlier
   [`SUMO_SPAWN_FAILED`](#error-sumo-spawn-failed).

<details><summary>Example — give the work more time</summary>

```js
// raise the verification timeout for long-running work
await session.verify({ sessionId, timeoutMs: 120_000 });
```
</details>

---

<a id="error-sumo-bad-harness"></a>
### `SUMO_BAD_HARNESS` — unknown harness name

**Raised from:** `sumo/hooks`

**What happened:** A command referenced a harness name Sumo does not recognize.

**Why it happens:** A typo, or a harness Sumo does not support.

**How to fix it:** Use a supported name. `sumo doctor` lists what is configured.

<details><summary>Example — use a known harness id</summary>

```sh
# ✗ sumo forward claude PreToolUse        (unknown 'claude')
sumo forward claude-code PreToolUse       # ✓ exact id
```
</details>

---

## Messenger (work claiming)

<a id="error-sumo-medium-error"></a>
### `SUMO_MEDIUM_ERROR` — an external work medium failed an operation

**Raised from:** `sumo/messenger` / messenger plugins

**What happened:** Sumo asked an external medium (for example GitHub) to claim, comment, release, heartbeat,
or publish liveness, and that medium returned an error.

**Why it happens:** The external CLI/API may be unavailable, unauthenticated, rate limited, or rejecting the
specific request.

**How to fix it:** Read the reason, verify the external tool works on its own, authenticate if needed, and
retry the operation once the medium is healthy.

<details><summary>Example — check the backing medium</summary>

```sh
gh auth status                 # for GitHub-backed work
gh issue view <number>         # confirm the repository/API is reachable
```
</details>

---

<a id="error-sumo-claim-held"></a>
### `SUMO_CLAIM_HELD` — the work item is already claimed

**Raised from:** `sumo/messenger`

**What happened:** An attempt to claim a unit of work (e.g. an issue) found it already claimed by another,
still-active agent.

**Why it happens:** Two agents competed for the same item; the other got there first and its claim is fresh.

**How to fix it:** This is expected coordination, not a bug — let the holder finish, or pick another item.
The message names the current holder.

<details><summary>Example — skip held work and take the next item</summary>

```js
const r = await messenger.claim(ref, me);
if (!r.ok && r.code === 'SUMO_CLAIM_HELD') {
  // r.heldBy names the holder; move on to a different item
  continue;
}
```
</details>

---

<a id="error-sumo-claim-lost"></a>
### `SUMO_CLAIM_LOST` — your claim was overtaken

**Raised from:** `sumo/messenger`

**What happened:** You held (or tried to take) a claim, but a check showed another agent is now the active
claimant — your claim is no longer valid.

**Why it happens:** A race: after you acted, a re-read showed someone else became the owner.

**How to fix it:** Stop working that item and re-select an unclaimed one. The message names who holds it now.

<details><summary>Example — release and re-select on a lost claim</summary>

```js
const r = await messenger.claim(ref, me);
if (!r.ok && r.code === 'SUMO_CLAIM_LOST') {
  // do not continue working `ref`; pick a fresh unclaimed item instead
}
```
</details>

---

## Orchestrator and sessions

<a id="error-sumo-runtime-starting"></a>
### `SUMO_RUNTIME_STARTING` — the project runtime is not ready yet

**Raised from:** `sumo/cli(onSteer | onSession | readyWithin)`

**What happened:** A request needed the per-project runtime, but it is still starting up (or shutting down),
so it could not be served right now.

**Why it happens:** The runtime is warming up within its readiness budget, it failed to start, or the host is
shutting down.

**How to fix it:**
1. Usually transient — wait a moment and retry; the request is safe to repeat.
2. If it persists, the runtime failed to start: the message often includes the reason. Check config and run
   `sumo doctor`.

<details><summary>Example — retry with a short backoff</summary>

```js
for (let i = 0; i < 5; i++) {
  const r = await call();
  if (!(r?.code === 'SUMO_RUNTIME_STARTING')) break;   // ready (or a different outcome)
  await new Promise((res) => setTimeout(res, 500));     // brief wait, then retry
}
```
</details>

---

<a id="error-sumo-session-unknown"></a>
### `SUMO_SESSION_UNKNOWN` — no such session

**Raised from:** `sumo/cli(onSession)`

**What happened:** An action referenced a session id with no record (or whose record has no working
directory).

**Why it happens:** The id is wrong, or the session was never registered.

**How to fix it:** List sessions, copy the exact id, and use it. If you expected it to exist, start it first.

<details><summary>Example — get the right id from `sumo list`</summary>

```sh
sumo list                     # shows live sessions and their exact ids
# copy the id column (e.g. ses_01J…) and pass that exact value to your command
```
</details>

---

<a id="error-sumo-session-dead"></a>
### `SUMO_SESSION_DEAD` — the session exists but is no longer running

**Raised from:** `sumo/cli(onSession)` / `sumo/orchestrator`

**What happened:** The session is known, but has no live process behind it — it ended, was cancelled, or was
orphaned.

**Why it happens:** You acted on a session after it finished or its process died.

**How to fix it:** Start a new session (or resume, if the harness supports it). Use `sumo list` to see which
sessions are live before acting.

<details><summary>Example — check liveness, then start fresh</summary>

```sh
sumo list                     # if your id is absent or marked done, it's dead
sumo run "<prompt>"           # start a new session and use its id
```
</details>

---

<a id="error-sumo-breaker-open"></a>
### `SUMO_BREAKER_OPEN` — repeated rapid failures opened the circuit breaker

**Raised from:** `sumo/orchestrator(guards)`

**What happened:** Sumo refused to start another session for the same spawn key because recent attempts died
too quickly too many times in a row.

**Why it happens:** The harness, prompt, cwd, or configuration is failing consistently. Starting more agents
would likely repeat the same failure and waste budget.

**How to fix it:** Fix the underlying launch failure first, then retry after the breaker window clears.

<details><summary>Example — investigate before retrying</summary>

```sh
sumo doctor                   # harness/config health
sumo list                     # inspect recent session states
```
</details>

---

<a id="error-sumo-max-rounds"></a>
### `SUMO_MAX_ROUNDS` — the spawn loop hit its per-key round limit

**Raised from:** `sumo/orchestrator(guards)`

**What happened:** A workflow tried to spawn more sessions for the same spawn key than its configured
`maxRounds` budget allows.

**Why it happens:** The loop is not converging, or the configured round budget is lower than the work needs.

**How to fix it:** Inspect why the workflow keeps spawning. Increase `maxRounds` only when the extra rounds
are expected and bounded.

<details><summary>Example — raise the limit intentionally</summary>

```yaml
orchestrator:
  guards:
    maxRounds: 8
```
</details>

---

<a id="error-sumo-max-agents"></a>
### `SUMO_MAX_AGENTS` — too many live agents are already running

**Raised from:** `sumo/orchestrator(guards)`

**What happened:** Sumo refused a new spawn because the configured concurrent-agent limit is already
reached.

**Why it happens:** Existing sessions are still running, or a previous workflow did not end them yet.

**How to fix it:** Wait for current sessions to finish, end ones you no longer need, or raise `maxAgents`
for this project if the concurrency is intentional.

<details><summary>Example — inspect and end sessions</summary>

```sh
sumo list
sumo end <session-id>
```
</details>

---

<a id="error-sumo-modify-invalid"></a>
### `SUMO_MODIFY_INVALID` — a `modify` handler was not a function (ignored)

**Raised from:** `sumo/orchestrator(decisions)`

**What happened:** A plugin registered a `modify(name, …)` whose handler argument was not a function. The
registration is ignored; everything else continues.

**Why it happens:** A coding mistake — passing something other than a function as the handler.

**How to fix it:** Pass a function. The message names the offending registration.

<details><summary>Example — pass a function handler</summary>

```js
// ✗ sumo.modify('prompt', { prepend: 'x' });   // not a function
// ✓
sumo.modify('prompt', (current) => `${current}\n\n(house rules apply)`);
```
</details>

---

<a id="error-sumo-guard-invalid"></a>
### `SUMO_GUARD_INVALID` — a `guard` was not a function (ignored)

**Raised from:** `sumo/orchestrator(guards)`

**What happened:** A plugin registered a `guard(name, …)` whose guard argument was not a function. The guard
is ignored.

**Why it happens:** A coding mistake. A guard must be a function that runs synchronously at spawn time.

**How to fix it:** Pass a function. The message names the rejected guard.

<details><summary>Example — a valid guard</summary>

```js
// ✗ sumo.guard('rate', true);          // not a function
// ✓ return falsy or { ok:false } to BLOCK the spawn; anything truthy allows it
sumo.guard('rate', (ctx) => activeCount < 5);
```
</details>

---

<a id="error-sumo-guard-async"></a>
### `SUMO_GUARD_ASYNC` — a `guard` returned a Promise (ignored)

**Raised from:** `sumo/orchestrator(guards)`

**What happened:** A guard ran but returned a Promise. Guards run **synchronously** in the spawn path (they
must decide before the first `await`), so an async guard's result cannot be honored and is ignored — meaning
your guard silently does nothing.

**Why it happens:** The guard is declared `async`, or it returns the result of an awaited/Promise-returning
call.

**How to fix it:** Make the guard synchronous. Do the async work *earlier* (e.g. on an event, or in plugin
setup), cache the result, and have the guard read the cached value and return a plain boolean / `{ ok:false }`.

<details><summary>Example — before (silently ignored) → after (synchronous)</summary>

```js
// ✗ async guard — returns a Promise, so it is ignored and never blocks anything
sumo.guard('quota', async (ctx) => {
  const remaining = await fetchQuota(ctx.user);   // Promise
  return remaining > 0;
});

// ✓ refresh asynchronously OUTSIDE the guard, cache the value, read it synchronously inside
let quotaOk = false;  // seed to the SAFE default: a guard may run before the first refresh
sumo.on('session.start', async (e) => { quotaOk = (await fetchQuota(e.user)) > 0; });
sumo.guard('quota', (ctx) => quotaOk);            // sync: returns the most recent cached value
```
The guard reads whatever the last refresh cached, so seed the cache to the safe default (block) and
refresh it on an event that fires *before* the spawns you guard — never assume the refresh has run yet.
</details>

---

## Hooks

<a id="error-sumo-hook-payload-invalid"></a>
### `SUMO_HOOK_PAYLOAD_INVALID` — a hook payload could not be parsed

**Raised from:** `sumo/hooks`

**What happened:** A harness invoked a Sumo hook and sent a payload on stdin that Sumo could not parse for
that harness and event.

**Why it happens:** A version mismatch between the harness integration and Sumo's hook handler, or a malformed
payload.

**How to fix it:** Make sure the harness integration and Sumo are compatible versions; reinstall the hooks if
you recently upgraded. The message names the harness and event and includes the parse error.

<details><summary>Example — reinstall hooks after an upgrade</summary>

```sh
sumo install claude-code      # rewrites the harness's hook wiring to match this Sumo version
```
</details>

---

<a id="error-sumo-hook-observe-failed"></a>
### `SUMO_HOOK_OBSERVE_FAILED` — recording a hook observation failed

**Raised from:** `sumo/hooks`

**What happened:** A hook fired and its payload parsed, but writing the resulting observation into the event
log failed.

**Why it happens:** Usually a downstream storage problem — e.g. the daemon became unreachable while the hook
was being processed.

**How to fix it:** Check the daemon is healthy (see [`SUMO_NO_DAEMON`](#error-sumo-no-daemon)). The message
includes the underlying failure; address it and retry the action that triggered the hook.

<details><summary>Example — confirm the daemon, then retry</summary>

```sh
sumo doctor                   # is the daemon up? if not, `sumo daemon`
```
</details>

---

## CLI

<a id="error-sumo-steering-unverified"></a>
### `SUMO_STEERING_UNVERIFIED` — session steering was not verified

**Raised from:** `sumo/harness`

**What happened:** A harness session started without verified Sumo-managed hook wiring for its project, so
steering-dependent behavior was disabled for that session.

**Why it happens:** The project-local hook config is missing, stale, unreadable, or does not contain Sumo's
managed hook marker for the harness.

**How to fix it:** Run `sumo install` for the project, then start a new session. Use `sumo doctor` to inspect
remaining install drift.

---

<a id="error-sumo-cli-name-shadowed"></a>
### `SUMO_CLI_NAME_SHADOWED` — a capability name is hidden by a built-in command (warning)

**Raised from:** `sumo/cli`

**What happened:** A plugin exposed a capability whose name equals a built-in `sumo` command. On the command
line the built-in wins, so that capability is not reachable as a CLI verb — though it is still available on
its other surfaces (MCP, programmatic). This is a warning.

**Why it happens:** A plugin chose a command name that collides with a reserved CLI verb.

**How to fix it:** If you need it on the CLI, rename the capability in the providing plugin. If not, the
warning is safe to ignore — reach it through another surface.

<details><summary>Example — rename to escape the collision</summary>

```js
// ✗ 'list' collides with the built-in `sumo list`
sumo.command('list', exec);
// ✓ a non-reserved name is reachable as `sumo my-list`
sumo.command('my-list', exec);
```
</details>

---

<a id="error-sumo-invalid-argument"></a>
### `SUMO_INVALID_ARGUMENT` — a required argument was missing or wrong

**Raised from:** `sumo/cli` / `plugins` (e.g. the GitHub marker)

**What happened:** A function or command was called with a missing or invalid argument (for example, a
required `type` was not provided).

**Why it happens:** A required value was omitted or had the wrong form. The message states which argument was
expected.

**How to fix it:** Supply the argument correctly and retry.

<details><summary>Example — provide the required field</summary>

```js
// message: type is required
marker({ type: 'review', ref: '123' });   // ✓ include the named required argument
```
</details>
