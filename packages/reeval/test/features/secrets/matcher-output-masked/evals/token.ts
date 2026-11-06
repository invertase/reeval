/** Made when the eval runs, so no file holds either whole: only what reeval writes could. */
export const TOKEN = ['ghp_A1b2C3d4E5f6G7h8', 'I9j0K1l2M3n4O5p6Q7r8'].join('')

/** A secret-named `c.exec` env value with no digit in it, so only the whole value is masked. */
export const PASSPHRASE = ['correct', 'horse', 'battery', 'staple', 'and', 'more', 'words'].join(
  '-',
)

/**
 * Prints the token on stdout and the passphrase on stderr, each ending 1970 characters before the
 * end of its stream, inside the last 2000 that `toSucceed` quotes, then exits with `code`.
 */
export const command = (code: number) =>
  [
    `printf '%s %s' "$GH" "$PAD"; printf '%s %s' "$EXEC_PASSWORD" "$PAD" >&2; exit ${code}`,
    { env: { GH: TOKEN, EXEC_PASSWORD: PASSPHRASE, PAD: 'w'.repeat(1970) } },
  ] as const
