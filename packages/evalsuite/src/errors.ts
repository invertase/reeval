/** A mistake in the config, an eval's options or the command line. Exits 2. */
export class UsageError extends Error {
  override name = 'UsageError'
}
