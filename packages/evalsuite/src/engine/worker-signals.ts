// Preloaded into every Vitest worker (`--import`), before it can receive anything. Ctrl-C reaches
// the whole process group; workers ignore it so the CLI can cancel the run and every eval gets to
// destroy its sandbox. A handler installed later, in a setup file, misses a Ctrl-C during boot.
process.on('SIGINT', () => {})
