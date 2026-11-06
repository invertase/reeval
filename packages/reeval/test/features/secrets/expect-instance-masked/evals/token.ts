/** Made when the eval runs, so no file holds either whole: only what reeval writes could. */
export const TOKEN = ['ghp_A1b2C3d4E5f6G7h8', 'I9j0K1l2M3n4O5p6Q7r8'].join('')

/**
 * A secret-named `c.exec` env value with no digit in it, so only the whole value is masked, and
 * longer than the 40 characters a failed matcher's message cuts a value to.
 */
export const PASSPHRASE = ['correct', 'horse', 'battery', 'staple', 'and', 'more', 'words'].join(
  '-',
)

/** Prints `nope <TOKEN>`, with the passphrase registered as `c.exec`'s own secret. */
export const COMMAND = [
  'printf %s "nope $GH"',
  { env: { GH: TOKEN, EXEC_PASSWORD: PASSPHRASE } },
] as const
