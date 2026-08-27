/** A trivial fixture plugin loaded by the module-specifier path in use.test.mjs. */
export default function echo(sumo, options) {
  sumo.command('echo', /** Run the callback. */ (args) => ({ echoed: args, options }));
}

echo.sumo = { name: 'echo-plugin' };
