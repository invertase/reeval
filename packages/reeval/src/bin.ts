#!/usr/bin/env node
// dist/cli.js, the `reeval` executable. `reeval __worker` is how the engine starts a worker for an eval
// file (engine/pool.ts), so a compiled reeval can start its own; anything else is the CLI.
import module from 'node:module'

// V8's code cache makes coverage of the functions it restores less precise.
if (!process.env.NODE_V8_COVERAGE) module.enableCompileCache?.()
if (process.argv[2] === '__worker') await import('./engine/worker-entry.ts')
else await import('./cli.ts')
