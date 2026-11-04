// The Tart sandbox descriptor's plain-data contract: what `tart()` returns and what a declaration
// tree from any language carries. The type in types.ts has the TSDoc; `_SameAsSchema` holds the
// two together.
import { z } from 'zod'
import { UsageError } from '../errors.ts'
import type { TartHost, TartSandboxDescriptor } from '../types.ts'
import { type Assert, closest, got, type Issue, nonEmpty, refusal, type Same } from './shared.ts'

/** macOS runs at most two macOS VMs at a time, whatever else is running. */
export const TART_MAX_CONCURRENT = 2

/** A memory size as `docker({ memory })` takes it: bytes, or a number with `b`, `k`, `m` or `g`. */
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i

const hostSchema = z.union([
  z.string(),
  z.strictObject({
    host: z.string(),
    user: z.string().optional(),
    port: z.int().optional(),
    identityFile: z.string().optional(),
    vms: z.int().optional(),
  }),
])

const fields = {
  id: nonEmpty().optional(),
  image: z.string().regex(/^\S+$/, 'one word'),
  maxConcurrent: z.number().optional(),
  cpus: z.int().positive().optional(),
  memory: z.union([z.string().regex(MEMORY), z.int().positive()]).optional(),
  ssh: z.strictObject({ user: nonEmpty().optional(), key: nonEmpty() }).optional(),
  hosts: z.array(hostSchema).optional(),
}

export const tartSandboxSchema = z.strictObject({ kind: z.literal('tart'), ...fields })

/** `tart()`'s argument: the descriptor's fields, with `ssh.key` relative or a `file:` URL. */
export const tartOptionsSchema = z.strictObject({
  ...fields,
  ssh: z
    .strictObject({ user: nonEmpty().optional(), key: z.union([nonEmpty(), z.instanceof(URL)]) })
    .optional(),
})

/** `tart()`'s argument, as users write it. */
export type TartOptions = Omit<TartSandboxDescriptor, 'kind' | 'ssh'> & {
  /** `key` is relative to the file that calls `tart()`, or an absolute path or `URL`. */
  ssh?: { user?: string; key: string | URL }
}

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof tartSandboxSchema>, TartSandboxDescriptor>>,
  Assert<Same<keyof z.infer<typeof tartSandboxSchema>, keyof TartSandboxDescriptor>>,
  Assert<Same<z.input<typeof tartOptionsSchema>, TartOptions>>,
  Assert<Same<z.infer<typeof hostSchema>, TartHost>>,
]

/** A host of `tart({ hosts })`, parsed: what `ssh` is given, and how many VMs it runs at once. */
export type ParsedTartHost = {
  /** The host as messages name it: the string as written, or `[user@]host[:port]`. */
  label: string
  host: string
  user?: string
  port?: number
  identityFile?: string
  vms: number
}

/** A user or host name `ssh` takes as one word, which can't be read as an option. */
const SSH_WORD = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
/** An IPv6 address in an `ssh://` URL's brackets. */
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/

const HOST_EXAMPLES = `'mac-studio', 'elliot@mac-mini.local' or 'ssh://ci@10.0.0.5:2222'`

/** `host`, one of `tart({ hosts })`, parsed; a sentence saying what's wrong with it otherwise. */
export function parseTartHost(host: TartHost): ParsedTartHost | string {
  if (typeof host === 'string') return parseHostString(host)
  const { host: name, user, port, identityFile, vms } = host
  const what = `{ host: ${got(name)} }`
  if (!SSH_WORD.test(name)) {
    return `${what}: host is a host name, address or ~/.ssh/config alias, with no user, port or spaces; put those in user and port`
  }
  if (user !== undefined && !SSH_WORD.test(user)) {
    return `${what}: user is a login name with no spaces (got ${got(user)})`
  }
  if (port !== undefined && !(port >= 1 && port <= 65535)) {
    return `${what}: port is a whole number from 1 to 65535 (got ${got(port)})`
  }
  if (identityFile !== undefined && !/^(\/|~\/)\S/.test(identityFile)) {
    return `${what}: identityFile is the path of a private key on this machine, absolute or starting ~/ (got ${got(identityFile)})`
  }
  if (vms !== undefined && !(vms >= 1 && vms <= TART_MAX_CONCURRENT)) {
    return `${what}: vms is 1 or 2, since macOS runs at most ${TART_MAX_CONCURRENT} macOS VMs at a time (got ${got(vms)})`
  }
  const label = `${user ? `${user}@` : ''}${name}${port ? `:${port}` : ''}`
  return {
    label,
    host: name,
    ...(user !== undefined && { user }),
    ...(port !== undefined && { port }),
    ...(identityFile !== undefined && { identityFile }),
    vms: vms ?? TART_MAX_CONCURRENT,
  }
}

function parseHostString(spec: string): ParsedTartHost | string {
  const what = got(spec)
  if (spec.startsWith('ssh://')) {
    let url: URL
    try {
      url = new URL(spec)
    } catch {
      return `${what} isn't an ssh:// URL: write ssh://[user@]host[:port]`
    }
    if (url.password) {
      return `${what} has a password: reeval reaches each host with plain ssh and no prompt, so use an ~/.ssh/config alias, the SSH agent or identityFile`
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      return `${what} has a path: write ssh://[user@]host[:port]`
    }
    const user = decodeURIComponent(url.username)
    if (!url.hostname || !(SSH_WORD.test(url.hostname) || IPV6.test(url.hostname))) {
      return `${what} names no host: write ssh://[user@]host[:port]`
    }
    if (user && !SSH_WORD.test(user)) return `${what}: the user is a login name with no spaces`
    return {
      label: spec,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      ...(user && { user }),
      ...(url.port && { port: Number(url.port) }),
      vms: TART_MAX_CONCURRENT,
    }
  }
  const at = spec.lastIndexOf('@')
  const user = at === -1 ? undefined : spec.slice(0, at)
  const host = spec.slice(at + 1)
  if (user?.includes(':')) {
    return `${what} has a password: reeval reaches each host with plain ssh and no prompt, so use an ~/.ssh/config alias, the SSH agent or identityFile`
  }
  if (host.includes(':')) {
    return `${what}: ssh takes no port in a destination; write ssh://${spec} or { host, port }`
  }
  if (!SSH_WORD.test(host) || (user !== undefined && !SSH_WORD.test(user))) {
    return `${what} isn't an SSH destination: write a host name or ~/.ssh/config alias, [user@]host, or ssh://[user@]host[:port]`
  }
  return { label: spec, host, ...(user !== undefined && { user }), vms: TART_MAX_CONCURRENT }
}

/** Every host of `hosts`, parsed; throws reeval's sentence for the first that's wrong. */
export function parseTartHosts(hosts: readonly TartHost[]): ParsedTartHost[] {
  const problem = tartHostsProblem(hosts)
  if (problem) throw new UsageError(problem)
  return hosts.map((h) => parseTartHost(h) as ParsedTartHost)
}

/** What's wrong with `tart({ hosts })`, or undefined. */
export function tartHostsProblem(hosts: readonly TartHost[]): string | undefined {
  if (!hosts.length) {
    return `tart({ hosts }) names no host: list at least one, such as ${HOST_EXAMPLES}, or leave hosts out to run the VMs on this machine`
  }
  const seen = new Map<string, number>()
  for (const [i, host] of hosts.entries()) {
    const parsed = parseTartHost(host)
    if (typeof parsed === 'string') return `tart({ hosts }) entry ${i + 1}: ${parsed}`
    const key = `${parsed.user ?? ''}@${parsed.host}:${parsed.port ?? ''}`
    const first = seen.get(key)
    if (first !== undefined) {
      return `tart({ hosts }) entries ${first + 1} and ${i + 1} are the same Mac, ${parsed.label}: list each once, and set its vms to run more on it`
    }
    seen.set(key, i)
  }
  return undefined
}

/** The most VMs `hosts` run at once: each one's `vms`, added up. */
export const tartHostsCapacity = (hosts: readonly TartHost[]) =>
  hosts.reduce((n, h) => {
    const parsed = parseTartHost(h)
    return n + (typeof parsed === 'string' ? TART_MAX_CONCURRENT : parsed.vms)
  }, 0)

/** What `docker()` takes that a VM has no use for, and why. */
const DOCKER_ONLY: Record<string, string> = {
  from: 'a Tart VM starts from its image, and reeval bakes only the harness onto it',
  dockerfile: 'a Tart VM starts from its image, and reeval bakes only the harness onto it',
  install:
    'a Tart VM starts from its image, and reeval bakes only the harness onto it; put install commands in the environment setup',
  root: 'the VM runs everything as the image user',
  capabilities: 'a macOS VM has no Linux capabilities',
  swap: 'macOS manages its own swap',
  pids: 'a macOS VM has no process limit',
  engine: 'Tart is its only engine',
}

const FIELD: Record<string, (value: unknown) => string> = {
  id: (v) => `tart({ id }) must be a non-empty string (got ${got(v)})`,
  image: (v) =>
    `tart({ image }) takes an OCI image or a local VM name with no spaces, e.g. image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' (got ${got(v)})`,
  maxConcurrent: (v) => `tart({ maxConcurrent }) takes a number (got ${got(v)})`,
  cpus: (v) => `tart({ cpus }) takes a whole number of CPUs above zero (got ${got(v)})`,
  memory: (v) => `tart({ memory }) takes a size such as '8g' or '4096m', or bytes (got ${got(v)})`,
  ssh: (v) =>
    `tart({ ssh }) takes { user?, key }, where key is the path of a private key the image trusts (got ${got(v)})`,
  hosts: (v) =>
    `tart({ hosts }) takes a list of Macs to reach over SSH, each ${HOST_EXAMPLES}, or { host, user?, port?, identityFile?, vms? } (got ${got(v)})`,
  kind: (v) => `a Tart sandbox's kind is "tart" (got ${got(v)})`,
}

const ORDER = ['kind', 'image', 'id', 'cpus', 'memory', 'ssh', 'hosts']

function explainTart(issue: Issue, value: unknown): string {
  const options = value as Record<string, unknown>
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    const key = issue.keys[0] as string
    if (DOCKER_ONLY[key]) return `tart() has no "${key}": ${DOCKER_ONLY[key]}.`
    if (key === 'environment' || key === 'env') {
      return `Unknown tart() option "${key}". Variables and secrets belong in defineEnvironment({ env }).`
    }
    const near = closest(key, Object.keys(fields))
    return `Unknown tart() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
  }
  const key = String(issue.path[0])
  return (FIELD[key] ?? ((v) => `tart({ ${key} }) is invalid (got ${got(v)})`))(options[key])
}

/** The most VMs a run of `options` may have at once: two, or what its hosts run. */
const vmLimit = (options: { hosts?: readonly TartHost[] }) =>
  options.hosts ? tartHostsCapacity(options.hosts) : TART_MAX_CONCURRENT

/** `tart()`'s options, checked; throws reeval's sentence for the first problem. */
export function checkTartOptions(options: TartOptions): void {
  const problem =
    refusal(tartOptionsSchema, options, explainTart, { order: ORDER }) ??
    (options.hosts && tartHostsProblem(options.hosts))
  if (problem) throw new UsageError(problem)
  const limit = vmLimit(options)
  if ((options.maxConcurrent ?? 0) > limit) {
    throw new UsageError(
      options.hosts
        ? `tart({ maxConcurrent }) is ${options.maxConcurrent}, but its hosts run at most ${limit} VMs at a time (each host's vms, 2 by default)`
        : `tart({ maxConcurrent }) is ${options.maxConcurrent}, but macOS runs at most ${TART_MAX_CONCURRENT} macOS VMs at a time`,
    )
  }
}

/** What's wrong with a Tart descriptor from any source, or undefined; `maxConcurrent` aside. */
export const tartProblem = (value: TartSandboxDescriptor) =>
  refusal(tartSandboxSchema, value, explainTart, { order: ORDER, skip: ['maxConcurrent'] }) ??
  (Array.isArray(value.hosts) ? tartHostsProblem(value.hosts) : undefined)

/** The most VMs a Tart descriptor runs at once across the run, and why. */
export const tartVmLimit = (sandbox: TartSandboxDescriptor) =>
  sandbox.hosts
    ? {
        max: vmLimit(sandbox),
        why: `its hosts run ${vmLimit(sandbox)} VMs at a time (each host's vms, 2 by default)`,
      }
    : { max: TART_MAX_CONCURRENT, why: 'macOS runs two macOS VMs at a time' }
