// `reeval cloud secrets` and `reeval cloud provider`: the cloud platform's eval secrets and
// provider keys, set, deleted and listed with the stored sign-in. A value goes in and never comes
// back out: it's read from stdin or a hidden prompt (or the local environment), never from the
// command line, and no message quotes it.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Flags } from './cli-spec.ts'
import {
  CLOUD_URL_VAR,
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

/** The AI SDK provider slugs the platform keeps keys for. */
export const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'mistral',
  'groq',
  'deepseek',
  'cohere',
  'perplexity',
  'fireworks',
  'togetherai',
  'cerebras',
  'deepinfra',
] as const

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const MAX_HOSTS = 20
const MAX_SECRET_BYTES = 16 * 1024
const MAX_KEY_BYTES = 4 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/gsu

/** The project in `.reeval/project.json`, else the platform's default one. */
export const DEFAULT_PROJECT = { orgId: 'org_default', projectId: 'proj_default' }

type Who = { id?: string; email?: string } | null
type Secret = {
  name: string
  mode: SecretMode
  hosts?: string[] | null
  version: number
  updatedAt?: string
  updatedBy?: Who
}
type ProviderKey = {
  provider: string
  projectId: string | null
  last4?: string
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

type Target = { base: URL; auth: CloudAuth; orgId: string; projectId: string }

async function target(command: string, io: SecretsIo): Promise<Target> {
  const env = io.env ?? process.env
  const base = cloudUrl(
    env,
    `reeval ${command} needs ${CLOUD_URL_VAR}, the cloud platform's URL: set it, then reeval login signs in.`,
  )
  const file = join(io.projectDir ?? resolve('.'), '.reeval', 'project.json')
  let linked: { orgId?: unknown; projectId?: unknown } | null = null
  try {
    linked = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new UsageError(`${file} isn't JSON with an orgId and a projectId`)
    }
  }
  if (linked && (typeof linked.orgId !== 'string' || typeof linked.projectId !== 'string')) {
    throw new UsageError(`${file} isn't JSON with an orgId and a projectId`)
  }
  return {
    base,
    auth: await cloudAuth(base, env),
    orgId: (linked?.orgId as string | undefined) ?? DEFAULT_PROJECT.orgId,
    projectId: (linked?.projectId as string | undefined) ?? DEFAULT_PROJECT.projectId,
  }
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
  `api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId)}/secrets${name ? `/${seg(name)}` : ''}`

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

/** ` (got <word>)` for a refused word, unless it could be the value given in the wrong place. */
const got = (word: string | undefined) =>
  word && /^[a-z][a-z0-9-]{0,31}$/.test(word) ? ` (got ${word})` : ''

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
    throw new UsageError(`--mode is brokered, sandbox or readable (got "${given}")`)
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
    const t = await target('cloud secrets list', io)
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
    const t = await target('cloud secrets delete', io)
    await send(t, secretsPath(t, secret), {
      method: 'DELETE',
      what: `delete ${secret}`,
      missing: `No secret named ${secret} in ${t.projectId}`,
    })
    io.out(`Deleted ${secret} from ${t.projectId}.`)
    return 0
  }
  if (action !== 'set') {
    throw new UsageError(`reeval cloud secrets needs set, delete or list${got(action)}`)
  }
  const secret = checkName(name, 'cloud secrets set')
  refuseArgv('cloud secrets set', value)
  const mode = modeOf(flags)
  const t = await target('cloud secrets set', io)
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

const providerPath = (t: Target, provider?: string) =>
  `api/orgs/${seg(t.orgId)}/providers${provider ? `/${seg(provider)}` : ''}`

/** `reeval cloud provider <provider> set|delete` and `reeval cloud provider list`. */
export async function providerCommand(
  flags: Flags,
  args: string[],
  io: SecretsIo,
): Promise<number> {
  const [provider, action, key] = args
  if (provider === 'list') {
    if (action !== undefined) throw new UsageError('reeval cloud provider list takes no arguments')
    const t = await target('cloud provider list', io)
    const { body } = await send<{ providers?: ProviderKey[] }>(t, providerPath(t), {
      method: 'GET',
      what: 'list the provider keys',
    })
    const keys = body?.providers ?? []
    if (flags.json) {
      io.out(JSON.stringify({ orgId: t.orgId, providers: keys }, null, 2))
      return 0
    }
    if (!keys.length) {
      io.out(`No provider keys in ${t.orgId}: reeval cloud provider <provider> set adds one.`)
      return 0
    }
    io.out(`${plural(keys.length, 'provider key')} in ${t.orgId}:`)
    for (const line of table([
      ['PROVIDER', 'FOR', 'KEY', 'VERSION', 'UPDATED'],
      ...keys.map((k) => [
        k.provider,
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
  if (!provider) {
    throw new UsageError(
      'reeval cloud provider needs a provider: reeval cloud provider <provider> set|delete, or list',
    )
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(
      `reeval cloud provider needs a provider the cloud platform keeps keys for${got(provider)}: ${PROVIDERS.join(', ')}`,
    )
  }
  if (action !== 'set' && action !== 'delete') {
    throw new UsageError(`reeval cloud provider ${provider} needs set or delete${got(action)}`)
  }
  const command = `cloud provider ${provider} ${action}`
  const t = await target(command, io)
  const scope = flags.project ? t.projectId : t.orgId
  if (action === 'delete') {
    if (key !== undefined) throw new UsageError(`reeval ${command} takes no value`)
    const path = `${providerPath(t, provider)}${flags.project ? `?projectId=${seg(t.projectId)}` : ''}`
    await send(t, path, {
      method: 'DELETE',
      what: `delete the ${provider} key`,
      missing: `No ${provider} key for ${scope}`,
    })
    io.out(`Deleted the ${provider} key for ${scope}.`)
    return 0
  }
  refuseArgv(command, key)
  signedIn(t, command)
  const read = await io.readValue(`the ${provider} key`)
  checkValue(read, `The ${provider} key`, MAX_KEY_BYTES)
  const bad = badCharacterAt(read)
  if (bad) {
    throw new UsageError(
      `The ${provider} key has whitespace or a control character at position ${bad}: give the key alone`,
    )
  }
  const { status, body } = await send<{ provider?: ProviderKey }>(t, providerPath(t, provider), {
    method: 'PUT',
    what: `set the ${provider} key`,
    body: { key: read, ...(flags.project && { projectId: t.projectId }) },
  })
  const saved = body?.provider
  if (!saved) throw new CloudError(`the cloud platform set the ${provider} key but didn't say how`)
  io.out(
    `${status === 201 ? 'Added' : 'Replaced'} the ${provider} key for ${scope}${saved.last4 ? ` (…${saved.last4})` : ''}, version ${saved.version}.`,
  )
  return 0
}

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

/** Where `.reeval/project.json` is looked for: beside the config, else here. */
export const projectDirFor = (configPath: string | undefined) =>
  configPath ? dirname(configPath) : resolve('.')
