// Where `reeval login` keeps each platform's sign-in, and the token a cloud call sends:
// `REEVAL_TOKEN` when it's set, else the stored sign-in's. The file holds who signed in and
// where the token is; the token itself is in the OS keychain when there is one, and only in the
// file (mode 0600) when there isn't.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { UsageError } from '../errors.ts'
import { readableCredentials } from '../view/record.ts'
import { keychain } from './keychain.ts'
import type { CredentialsFile, SignedInUser, StoredLogin } from './types.ts'

/** A bearer token the cloud calls send, when it's set; it takes precedence over `reeval login`'s. */
export const CLOUD_TOKEN_VAR = 'REEVAL_TOKEN'

/** reeval's config directory: `XDG_CONFIG_HOME/reeval`, else `%APPDATA%\reeval` or `~/.config/reeval`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32'
      ? env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.config'))
  return join(base, 'reeval')
}

export const credentialsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(configDir(env), 'credentials.json')

const empty = (): CredentialsFile => ({ schemaVersion: 1, logins: {} })

async function readCredentials(env: NodeJS.ProcessEnv): Promise<CredentialsFile> {
  const file = credentialsPath(env)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UsageError(`${file} isn't JSON: delete it, then reeval login signs in again`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(
      `${file} isn't reeval's credentials: delete it, then reeval login signs in again`,
    )
  }
  const doc = readableCredentials(parsed as CredentialsFile, file)
  if (typeof doc.logins !== 'object' || doc.logins === null) doc.logins = {}
  return doc
}

/** Writes the file through a temporary one, readable by this user alone. */
async function writeCredentials(doc: CredentialsFile, env: NodeJS.ProcessEnv): Promise<void> {
  const file = credentialsPath(env)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const partial = `${file}.${process.pid}.tmp`
  await rm(partial, { force: true })
  await writeFile(partial, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  await chmod(partial, 0o600)
  await rename(partial, file)
}

/**
 * The platform's key in the file and the keychain: its URL's bare origin (`https://cloud.reeval.ai`),
 * so every spelling of the URL (a trailing `/`, a path, upper case, a default port) is one sign-in.
 */
export const platformKey = (base: URL | string) => new URL(base).origin

/** The sign-in `reeval login` stored for the platform, with its token (null when it's gone). */
export async function storedLogin(
  base: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ login: StoredLogin; token: string | null } | null> {
  const login = (await readCredentials(env)).logins[platformKey(base)]
  if (!login) return null
  if (login.store === 'file') return { login, token: login.token || null }
  return { login, token: (await keychain(env)?.get(platformKey(base))) ?? null }
}

/**
 * Stores the platform's sign-in, replacing any it had: the token in the keychain when it takes
 * it, else in the file. Returns where the token went, as `reeval login` names it.
 */
export async function saveLogin(
  base: URL,
  token: string,
  user: SignedInUser,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const doc = await readCredentials(env)
  const key = platformKey(base)
  const chain = keychain(env)
  const kept = chain && (await chain.set(key, token)) && (await chain.get(key)) === token
  if (chain && !kept) await chain.delete(key)
  doc.logins[key] = {
    store: kept ? 'keychain' : 'file',
    ...(kept ? {} : { token }),
    user,
    signedInAt: new Date().toISOString(),
  }
  await writeCredentials(doc, env)
  return kept && chain ? chain.name : credentialsPath(env)
}

/** Removes the platform's sign-in from the file and the keychain. */
export async function removeLogin(base: URL, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const doc = await readCredentials(env)
  const key = platformKey(base)
  const login = doc.logins[key]
  if (login?.store === 'keychain') await keychain(env)?.delete(key)
  delete doc.logins[key]
  if (Object.keys(doc.logins).length) await writeCredentials(doc, env)
  else await rm(credentialsPath(env), { force: true })
}

/** Where a cloud call's token came from: `REEVAL_TOKEN`, or `reeval login`'s keychain or file. */
export type CloudToken = { token: string; from: 'env' | StoredLogin['store'] }

/** Refuses a token that would break the `Authorization` header, naming where it came from. */
function checkToken(token: string, what: string): void {
  const bad = [...token].findIndex((c) => /[\s\p{Cc}]/u.test(c))
  if (bad < 0) return
  const code = token.codePointAt(bad)?.toString(16).padStart(4, '0')
  throw new UsageError(
    `${what} has whitespace or a control character (U+${code}) at position ${bad + 1}: set it to the token alone.`,
  )
}

/** The bearer token for the platform: `REEVAL_TOKEN` when it's set, else `reeval login`'s. */
export async function cloudToken(
  base: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudToken | null> {
  const fromEnv = env[CLOUD_TOKEN_VAR]?.trim()
  if (fromEnv) {
    checkToken(fromEnv, CLOUD_TOKEN_VAR)
    return { token: fromEnv, from: 'env' }
  }
  const stored = await storedLogin(base, env)
  if (!stored?.token) return null
  checkToken(stored.token, `The token reeval login stored for ${platformKey(base)}`)
  return { token: stored.token, from: stored.login.store }
}
