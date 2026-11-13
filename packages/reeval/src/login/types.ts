/** The user a sign-in belongs to, as the platform named them when it was made. */
export type SignedInUser = {
  id?: string
  email: string
  name?: string | null
}

/** One platform's sign-in from `reeval login`. */
export type StoredLogin = {
  /**
   * Where the token is: `keychain`, the OS keychain (the macOS keychain, or the Secret Service
   * through `secret-tool` on Linux) under the platform's origin, or `file`, in `token`.
   */
  store: 'keychain' | 'file'
  /** The bearer token, only when `store` is `file`. */
  token?: string
  user: SignedInUser
  /** When `reeval login` signed in, as an ISO timestamp. */
  signedInAt: string
}

/**
 * `credentials.json` in reeval's config directory (`XDG_CONFIG_HOME/reeval`, else
 * `~/.config/reeval`, or `%APPDATA%\reeval` on Windows), mode `0600`: each platform's sign-in,
 * keyed by the origin of its `REEVAL_CLOUD_URL`, with no trailing `/` or path.
 */
export type CredentialsFile = {
  schemaVersion: 1
  logins: Record<string, StoredLogin>
}
