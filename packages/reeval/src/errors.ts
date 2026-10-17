/** The eval clock, or the engine's hard wall, fired. */
export class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/** A tagged `TimeoutError` or a `DOMException` with that name, not a message that says "timed out". */
export const isTimeout = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError'

/** A mistake in the config, an eval's options or the command line. Exits 2. */
export class UsageError extends Error {
  override name = 'UsageError'
}
