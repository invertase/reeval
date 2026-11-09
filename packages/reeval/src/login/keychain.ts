// The OS keychain `reeval login` keeps its token in: the macOS keychain through `security`, or
// the Secret Service through `secret-tool` on Linux. The token goes to either on stdin, never on
// a command line another user's `ps` could read. With neither, the token goes in the credentials
// file instead.
import { spawn } from 'node:child_process'

/** The keychain item's service; its account is the platform's URL. */
const SERVICE = 'reeval'
const TIMEOUT_MS = 10_000

export type Keychain = {
  /** How `reeval login` names it: `the macOS keychain`. */
  name: string
  /** Stores `token` for `account`; false when the keychain didn't take it. */
  set(account: string, token: string): Promise<boolean>
  get(account: string): Promise<string | null>
  delete(account: string): Promise<void>
}

type Ran = { code: number | null; stdout: string }

function exec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
): Promise<Ran | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: TIMEOUT_MS,
      windowsHide: true,
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** What `security -i` takes as one quoted word: printable ASCII without a quote or backslash. */
const quotable = (s: string) => /^[\x20-\x7e]+$/.test(s) && !/["\\]/.test(s)

const macos = (env: NodeJS.ProcessEnv): Keychain => ({
  name: 'the macOS keychain',
  async set(account, token) {
    if (!quotable(account) || !quotable(token)) return false
    const line = `add-generic-password -U -s ${SERVICE} -l "reeval login" -a "${account}" -w "${token}"\n`
    const ran = await exec('security', ['-i'], env, line)
    return ran?.code === 0
  },
  async get(account) {
    const ran = await exec(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      env,
    )
    return ran?.code === 0 ? ran.stdout.trim() || null : null
  },
  async delete(account) {
    await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account], env)
  },
})

const secretService = (env: NodeJS.ProcessEnv): Keychain => ({
  name: 'the Secret Service keyring',
  async set(account, token) {
    const ran = await exec(
      'secret-tool',
      ['store', `--label=reeval login (${account})`, 'service', SERVICE, 'account', account],
      env,
      token,
    )
    return ran?.code === 0
  },
  async get(account) {
    const ran = await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', account], env)
    return ran?.code === 0 ? ran.stdout.trim() || null : null
  },
  async delete(account) {
    await exec('secret-tool', ['clear', 'service', SERVICE, 'account', account], env)
  },
})

/**
 * This machine's keychain, or null when it has none reeval uses: `REEVAL_NO_KEYCHAIN` is set,
 * it's Windows, or Linux without a D-Bus session (the Secret Service needs one).
 */
export function keychain(env: NodeJS.ProcessEnv = process.env): Keychain | null {
  if (env.REEVAL_NO_KEYCHAIN) return null
  if (process.platform === 'darwin') return macos(env)
  if (process.platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS) return secretService(env)
  return null
}
