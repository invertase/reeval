// Preloaded into every Vitest worker (`--import`), before it can receive anything. Ctrl-C reaches
// the whole process group; workers ignore it so the CLI can cancel the run and every eval gets to
// destroy its sandbox. A handler installed later, in a setup file, misses a Ctrl-C during boot.
process.on('SIGINT', () => {})

// Vitest ends fork workers with SIGTERM, which kills them before V8 writes NODE_V8_COVERAGE.
// Exiting on it writes the worker's coverage, as Vitest does itself for --cpu-prof.
if (process.env.NODE_V8_COVERAGE) process.on('SIGTERM', () => process.exit())
