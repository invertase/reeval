// `reeval cloud secrets`, `reeval cloud provider` and `reeval cloud gateway`: the cloud platform's
// eval secrets and provider and gateway keys, set, deleted and listed with the stored sign-in. A
// value goes in and never comes back out: it's read from stdin or a hidden prompt (or the local
// environment), never from the command line, and no message quotes it.
import { resolve } from 'node:path'
import type { Flags } from './cli-spec.ts'
import { cloudScope, linkedProject } from './cloud-project.ts'
import {
  type CloudAuth,
  CloudError,
  cloudAuth,
  cloudUrl,
  platformError,
  request,
} from './cloud-run.ts'
import { UsageError } from './errors.ts'
import { badCharacterAt } from './redact.ts'
import { plural } from './text.ts'

export const SECRET_MODES = ['brokered', 'sandbox', 'readable'] as const
export type SecretMode = (typeof SECRET_MODES)[number]

const MAX_KEY_NAME = 64
const KEY_NAME = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/
const KEY_PREFIX =
  /^(sk|pk|rk|csk|gsk|vck|xai|ghp|gho|ghs|github_pat|glpat|hf|r8|pplx|fw)[-_]|^AIza/

/** Bits per character, over the string's own characters. */
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length)
  return bits
}

/**
 * Which providers and gateways exist is the platform's answer, but a key pasted where the name
 * goes would land in a request path and in reeval's messages, so a name shaped like one never
 * leaves here.
 */
function looksLikeKey(name: string): boolean {
  if (name.length > MAX_KEY_NAME || KEY_PREFIX.test(name)) return true
  if (name.length < 16 || !/\d/.test(name)) return false
  return (/[a-z]/.test(name) && /[A-Z]/.test(name)) || (name.length >= 20 && entropy(name) >= 3.5)
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const MAX_HOSTS = 20
const MAX_SECRET_BYTES = 16 * 1024
const MAX_KEY_BYTES = 4 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|[^\r\n\u0003\u0004])?/gu

type Who = { id?: string; email?: string } | null
type Secret = {
  name: string
  mode: SecretMode
  hosts?: string[] | null
  version: number
  updatedAt?: string
  updatedBy?: Who
}

export type SecretsIo = {
  out: (line: string) => void
  /** The value, read from stdin or a hidden prompt; `what` names it in the prompt. */
  readValue: (what: string) => Promise<string>
  env?: NodeJS.ProcessEnv
  /** Where `.reeval/project.json` is looked for: the config's directory, else here. */
  projectDir?: string
}

export type Target = { base: URL; auth: CloudAuth; orgId: string; projectId?: string }

/**
 * The org, and the project when `project` is `'required'` or `--project` names one: `--org` and
 * `--project`, else the link in `.reeval/project.json`.
 */
export async function target(
  io: Pick<SecretsIo, 'env' | 'projectDir'>,
  flags: Flags,
  command: string,
  project: 'required' | 'optional',
): Promise<Target> {
  const env = io.env ?? process.env
  const base = cloudUrl(env)
  const auth = await cloudAuth(base, env)
  const linked = await linkedProject(io.projectDir ?? resolve('.'))
  const get = async (path: string, what: string) => {
    if (!auth.headers.authorization) {
      throw new UsageError(`reeval ${command} needs you signed in: ${auth.refused}`)
    }
    const answer = await request(
      new URL(path, base),
      { method: 'GET', what, redirect: 'error' },
      auth.headers,
    )
    if (!answer.ok) throw platformError(answer, what, auth)
    return answer.body
  }
  const scope = await cloudScope({ flags, linked, get, command, project })
  return { base, auth, ...scope }
}

const seg = encodeURIComponent

/** One platform call; `missing` is the refusal for a 404, when there's no such thing to change. */
async function send<T>(
  t: Target,
  path: string,
  init: { method: string; what: string; body?: unknown; missing?: string },
): Promise<{ status: number; body: T }> {
  const answer = await request(
    new URL(path, t.base),
    {
      method: init.method,
      what: init.what,
      // A redirect would resend the value, and the token, to wherever it points.
      redirect: 'error',
      ...(init.body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(init.body),
      }),
    },
    t.auth.headers,
  )
  if (answer.status === 404 && init.missing) throw new UsageError(init.missing)
  if (!answer.ok) throw platformError(answer, init.what, t.auth)
  return { status: answer.status, body: answer.body as T }
}

const secretsPath = (t: Target, name?: string) =>
  `api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId ?? '')}/secrets${name ? `/${seg(name)}` : ''}`

/** A value given on the command line lands in shell history and other processes can see it. */
function refuseArgv(command: string, given: string | undefined): void {
  if (given === undefined) return
  throw new UsageError(
    `reeval ${command} takes the value on stdin or at its prompt, not as an argument, which would land in your shell history: leave it out.`,
  )
}

/** Refuses before the value is read when there's no token to send it with. */
function signedIn(t: Target, command: string): void {
  if (!t.auth.headers.authorization) {
    throw new UsageError(`reeval ${command} needs you signed in: ${t.auth.refused}`)
  }
}

function checkValue(value: string, what: string, max: number): void {
  if (!value) throw new UsageError(`${what} is empty`)
  if (Buffer.byteLength(value) > max) {
    throw new UsageError(`${what} is over ${max / 1024} KiB`)
  }
}

function checkName(name: string | undefined, command: string): string {
  if (!name) throw new UsageError(`reeval ${command} needs the secret's name`)
  if (!NAME.test(name)) {
    throw new UsageError(
      `the secret's name isn't one: letters, digits and _, not starting with a digit, at most 128. reeval doesn't repeat it, in case it's the value`,
    )
  }
  return name
}

/** `--mode` and `--host` as the request sends them: neither, or a mode with its hosts. */
function modeOf(flags: Flags): { mode?: SecretMode; hosts?: string[] } {
  const hosts = (flags.host ?? []).map((h) => h.trim().toLowerCase())
  const given = flags.mode
  if (given !== undefined && !SECRET_MODES.includes(given as SecretMode)) {
    throw new UsageError('--mode is brokered, sandbox or readable')
  }
  const mode = (given as SecretMode | undefined) ?? (hosts.length ? 'brokered' : undefined)
  if (mode === 'brokered' && !hosts.length) {
    throw new UsageError(
      'A brokered secret needs --host, the hosts reeval may send it to (repeat it for more): --host api.example.com',
    )
  }
  if (mode && mode !== 'brokered' && hosts.length) {
    throw new UsageError(
      `--host is for a brokered secret; a ${mode} secret isn't swapped in on hosts, so leave it out`,
    )
  }
  if (hosts.length > MAX_HOSTS) throw new UsageError(`--host takes at most ${MAX_HOSTS} hosts`)
  const bad = hosts.find((h) => !HOST.test(h) || h.length > 253)
  if (bad !== undefined) {
    throw new UsageError(
      `--host ${bad} isn't a host name: give it with no scheme, port or path (api.example.com, or *.example.com for its subdomains)`,
    )
  }
  return mode ? { mode, ...(mode === 'brokered' && { hosts: [...new Set(hosts)] }) } : {}
}

const describe = (s: Pick<Secret, 'mode' | 'hosts'>) =>
  s.mode === 'brokered' && s.hosts?.length ? `brokered to ${s.hosts.join(', ')}` : s.mode

const by = (who: Who | undefined) => who?.email ?? who?.id ?? ''

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? []
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/** `reeval cloud secrets set|delete|list`. */
export async function secretsCommand(flags: Flags, args: string[], io: SecretsIo): Promise<number> {
  const [action, name, value] = args
  const env = io.env ?? process.env
  if (action === 'list') {
    if (name !== undefined) throw new UsageError('reeval cloud secrets list takes no arguments')
    const t = await target(io, flags, 'cloud secrets list', 'required')
    const { body } = await send<{ secrets?: Secret[] }>(t, secretsPath(t), {
      method: 'GET',
      what: 'list the secrets',
    })
    const secrets = body?.secrets ?? []
    if (flags.json) {
      io.out(JSON.stringify({ orgId: t.orgId, projectId: t.projectId, secrets }, null, 2))
      return 0
    }
    if (!secrets.length) {
      io.out(`No secrets in ${t.projectId}: reeval cloud secrets set <name> adds one.`)
      return 0
    }
    io.out(`${plural(secrets.length, 'secret')} in ${t.projectId}:`)
    for (const line of table([
      ['NAME', 'MODE', 'HOSTS', 'VERSION', 'UPDATED'],
      ...secrets.map((s) => [
        s.name,
        s.mode,
        s.hosts?.join(', ') || '-',
        String(s.version),
        [s.updatedAt?.slice(0, 16).replace('T', ' '), by(s.updatedBy)].filter(Boolean).join(' by '),
      ]),
    ])) {
      io.out(`  ${line}`)
    }
    return 0
  }
  if (action === 'delete') {
    const secret = checkName(name, 'cloud secrets delete')
    if (value !== undefined) throw new UsageError('reeval cloud secrets delete takes one name')
    const t = await target(io, flags, 'cloud secrets delete', 'required')
    await send(t, secretsPath(t, secret), {
      method: 'DELETE',
      what: `delete ${secret}`,
      missing: `No secret named ${secret} in ${t.projectId}`,
    })
    io.out(`Deleted ${secret} from ${t.projectId}.`)
    return 0
  }
  if (action !== 'set') {
    throw new UsageError(`reeval cloud secrets needs set, delete or list`)
  }
  const secret = checkName(name, 'cloud secrets set')
  refuseArgv('cloud secrets set', value)
  const mode = modeOf(flags)
  const t = await target(io, flags, 'cloud secrets set', 'required')
  if (!mode.mode) {
    const { body } = await send<{ secrets?: Secret[] }>(t, secretsPath(t), {
      method: 'GET',
      what: 'list the secrets',
    })
    if (!body?.secrets?.some((s) => s.name === secret)) {
      throw new UsageError(
        `${secret} is a new secret: give --host <host> for a brokered one, or --mode sandbox or --mode readable`,
      )
    }
  }
  signedIn(t, 'cloud secrets set')
  let read: string
  if (flags['from-env']) {
    const local = env[secret]
    if (local === undefined) throw new UsageError(`--from-env: ${secret} isn't set here`)
    read = local
  } else {
    read = await io.readValue(secret)
  }
  checkValue(read, `${secret}'s value`, MAX_SECRET_BYTES)
  const bad = badCharacterAt(read)
  if (bad && mode.mode === 'brokered') {
    throw new UsageError(
      `${secret}'s value has whitespace or a control character at position ${bad}, and a brokered value goes in a request header: give the value alone`,
    )
  }
  const { status, body } = await send<{ secret?: Secret }>(t, secretsPath(t, secret), {
    method: 'PUT',
    what: `set ${secret}`,
    body: { value: read, ...mode },
  })
  const saved = body?.secret
  if (!saved) throw new CloudError(`the cloud platform set ${secret} but didn't say how`)
  io.out(
    `${status === 201 ? 'Added' : 'Replaced'} ${secret} in ${t.projectId}: ${describe(saved)}, version ${saved.version}.`,
  )
  return 0
}

/** A kind of org key the platform stores by name: an AI SDK provider's, or a model gateway's. */
type KeyKind = {
  /** The word for one, in commands and messages. */
  noun: 'provider' | 'gateway'
  /** How a valid name is described when one isn't. */
  shape: string
  /** The platform's route under the org. */
  route: 'providers' | 'gateways'
}

const PROVIDER_KIND: KeyKind = { noun: 'provider', shape: "a provider's slug", route: 'providers' }
const GATEWAY_KIND: KeyKind = { noun: 'gateway', shape: "a gateway's name", route: 'gateways' }

type StoredKey = {
  provider?: string
  gateway?: string
  projectId: string | null
  last4?: string
  version: number
  updatedAt?: string
  updatedBy?: Who
}

const keyPath = (kind: KeyKind, t: Target, name?: string) =>
  `api/orgs/${seg(t.orgId)}/${kind.route}${name ? `/${seg(name)}` : ''}`

/** `reeval cloud <noun> set|delete <name>` and `reeval cloud <noun> list`. */
async function keyCommand(
  kind: KeyKind,
  flags: Flags,
  args: string[],
  io: SecretsIo,
): Promise<number> {
  const { noun } = kind
  const [action, name, key] = args
  if (action === 'list') {
    if (name !== undefined) throw new UsageError(`reeval cloud ${noun} list takes no arguments`)
    if (flags.project !== undefined) {
      throw new UsageError(
        `reeval cloud ${noun} list takes --org, not --project: it lists the org's keys and every project's override`,
      )
    }
    const t = await target(io, flags, `cloud ${noun} list`, 'optional')
    const { body } = await send<Record<string, StoredKey[] | undefined>>(t, keyPath(kind, t), {
      method: 'GET',
      what: `list the ${noun} keys`,
    })
    const keys = body?.[kind.route] ?? []
    if (flags.json) {
      io.out(JSON.stringify({ orgId: t.orgId, [kind.route]: keys }, null, 2))
      return 0
    }
    if (!keys.length) {
      io.out(`No ${noun} keys in ${t.orgId}: reeval cloud ${noun} set <${noun}> adds one.`)
      return 0
    }
    io.out(`${plural(keys.length, `${noun} key`)} in ${t.orgId}:`)
    for (const line of table([
      [noun.toUpperCase(), 'FOR', 'KEY', 'VERSION', 'UPDATED'],
      ...keys.map((k) => [
        k[noun] ?? '-',
        k.projectId ?? 'the org',
        k.last4 ? `…${k.last4}` : '-',
        String(k.version),
        [k.updatedAt?.slice(0, 16).replace('T', ' '), by(k.updatedBy)].filter(Boolean).join(' by '),
      ]),
    ])) {
      io.out(`  ${line}`)
    }
    return 0
  }
  if (action !== 'set' && action !== 'delete') {
    throw new UsageError(
      `reeval cloud ${noun} has no such subcommand: reeval cloud ${noun} set <${noun}>, delete <${noun}> or list`,
    )
  }
  if (!name) {
    throw new UsageError(
      `reeval cloud ${noun} ${action} needs the ${noun}: reeval cloud ${noun} ${action} <${noun}>`,
    )
  }
  if (looksLikeKey(name)) {
    throw new UsageError(
      `reeval cloud ${noun} ${action}: that looks like a key, not a ${noun} name, so reeval didn't send or repeat it. Give the ${noun} (reeval cloud ${noun} set <${noun}>) and the key on stdin or at the prompt`,
    )
  }
  if (!KEY_NAME.test(name)) {
    throw new UsageError(
      `reeval cloud ${noun} ${action} needs ${kind.shape}: lowercase letters and digits, joined by -, _ or ., at most ${MAX_KEY_NAME}. reeval doesn't repeat it, in case it's a key`,
    )
  }
  const command = `cloud ${noun} ${action} ${name}`
  if (action === 'delete' && key !== undefined) {
    throw new UsageError(`reeval ${command} takes no value`)
  }
  const t = await target(io, flags, command, 'optional')
  const forProject = t.projectId !== undefined
  const scope = t.projectId ?? t.orgId
  if (action === 'delete') {
    const path = `${keyPath(kind, t, name)}${forProject ? `?projectId=${seg(t.projectId ?? '')}` : ''}`
    await send(t, path, {
      method: 'DELETE',
      what: `delete the ${name} key`,
      missing: `No ${name} key for ${scope}`,
    })
    io.out(`Deleted the ${name} key for ${scope}.`)
    return 0
  }
  refuseArgv(command, key)
  signedIn(t, command)
  const read = await io.readValue(`the ${name} key`)
  checkValue(read, `The ${name} key`, MAX_KEY_BYTES)
  const bad = badCharacterAt(read)
  if (bad) {
    throw new UsageError(
      `The ${name} key has whitespace or a control character at position ${bad}: give the key alone`,
    )
  }
  const { status, body } = await send<Record<string, StoredKey | undefined>>(
    t,
    keyPath(kind, t, name),
    {
      method: 'PUT',
      what: `set the ${name} key`,
      body: { key: read, ...(forProject && { projectId: t.projectId }) },
    },
  )
  const saved = body?.[noun]
  if (!saved) throw new CloudError(`the cloud platform set the ${name} key but didn't say how`)
  io.out(
    `${status === 201 ? 'Added' : 'Replaced'} the ${name} key for ${scope}${saved.last4 ? ` (…${saved.last4})` : ''}, version ${saved.version}.`,
  )
  return 0
}

/** `reeval cloud provider set|delete <provider>` and `reeval cloud provider list`. */
export const providerCommand = (flags: Flags, args: string[], io: SecretsIo) =>
  keyCommand(PROVIDER_KIND, flags, args, io)

/** `reeval cloud gateway set|delete <gateway>` and `reeval cloud gateway list`. */
export const gatewayCommand = (flags: Flags, args: string[], io: SecretsIo) =>
  keyCommand(GATEWAY_KIND, flags, args, io)

/**
 * The value from stdin when it isn't a terminal (one trailing line break dropped), else from a
 * prompt on stderr that doesn't echo it.
 */
export async function readSecretValue(what: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '')
  }
  process.stderr.write(`Value for ${what} (hidden): `)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  try {
    return await new Promise<string>((resolveValue, reject) => {
      const typed: string[] = []
      const stop = () => {
        stdin.off('data', onData)
        stdin.off('end', onEnd)
      }
      const onEnd = () => {
        stop()
        reject(new UsageError('stdin closed before the value was entered; nothing was set.'))
      }
      const onData = (data: string) => {
        // An arrow, function key or paste bracket arrives as an escape sequence: none of it is
        // the value, but what follows it in the same chunk is.
        for (const ch of data.replace(ESCAPE_SEQUENCE, '')) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            stop()
            resolveValue(typed.join(''))
            return
          }
          if (ch === '\u0003') {
            stop()
            reject(new UsageError('Canceled; nothing was set.'))
            return
          }
          if (ch === '\u007f' || ch === '\b') typed.pop()
          else if (!/\p{Cc}/u.test(ch)) typed.push(ch)
        }
      }
      stdin.on('data', onData)
      stdin.once('end', onEnd)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    process.stderr.write('\n')
  }
}
