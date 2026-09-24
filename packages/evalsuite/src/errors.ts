/** Vitest's, the harness's and ES's own timeout messages all say "timed out". */
export const isTimeout = (message: string) => /timed out/i.test(message)

/** A mistake in the config, an eval's options or the command line. Exits 2. */
export class UsageError extends Error {
  override name = 'UsageError'
}
