#!/usr/bin/env node
// dist/cli.js, the `es` executable. `es __worker` is how the engine starts a worker for an eval
// file (engine/pool.ts), so a compiled es can start its own; anything else is the CLI.
if (process.argv[2] === '__worker') await import('./engine/worker-entry.ts')
else await import('./cli.ts')
