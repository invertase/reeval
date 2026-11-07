// boat.dev VMs as sandboxes: the Boat SDK (an optional peer, imported only here) creates and deletes
// them, and every process runs over SSH with a per-attempt key, the egress gateway's forwarder
// included, so credentials stay on the host as they do for Docker.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect, isIPv6 } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectSsh, SANDBOX_USER } from '@reeval/sandbox-docker'
import { run } from '@reeval/sandbox-docker/process'
import { attemptDebug } from '../debug/attempt.ts'
import type { Check } from '../doctor.ts'
import { egressLabel } from '../egress.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import type { BoatSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import type { DoctorContext } from './kinds.ts'
import { PrepareError } from './provider.ts'
import { startSandbox } from './start.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

const BOAT_SDK = '@boatdev/sdk'
export const BOAT_BASE_URL = 'BOAT_BASE_URL'

/** What reeval reads of a sandbox, typed here so no SDK type reaches reeval's own. */
type BoatSandboxInfo = {
  id: string
  name: string
  state: string
  error?: string | null
}

/** What Boat answers when it authorizes a key: the user, the host key and where sshd answers. */
type BoatSshReply = {
  sshUser?: string
  /** The VM's own address, whose sshd is on port 22: IPv6 on Boat's hosts. */
  machineIp?: string | null
  /** `<public IPv4>:<port>`, forwarded to the VM's sshd, when it has no public IPv4 of its own. */
  sshEndpoint?: string | null
  hostKey?: string
}

/** The SDK calls reeval makes. */
export type BoatClient = {
  create(p: {
    idempotencyKey?: string
    createSandboxRequest: {
      type: string
      name: string
      ttlSeconds: number
      noEnv: boolean
      snapshots: boolean
      monitoring: boolean
    }
  }): Promise<{ sandbox: BoatSandboxInfo }>
  get(p: { sandboxId: string }): Promise<{ sandbox: BoatSandboxInfo }>
  sshKey(p: { sandboxId: string; sshKeyRequest: { key: string } }): Promise<BoatSshReply>
  sandboxes(
    p: { namePrefix?: string; limit?: number; cursor?: string },
    init?: { signal?: AbortSignal },
  ): Promise<{
    sandboxes: BoatSandboxInfo[]
    pageInfo?: { nextCursor: string | null; hasMore: boolean }
  }>
  deleteSandbox(
    p: { sandboxId: string; xAsciiConfirmDelete: string },
    init?: { signal?: AbortSignal },
  ): Promise<unknown>
  limits(
    p?: Record<string, never>,
    init?: { signal?: AbortSignal },
  ): Promise<{
    canStart: boolean
    startBlockedReason?: string
    activeSandboxes: number
    maxActiveSandboxes: number
    machineTypes?: Array<{ type: string; available: boolean; reason: string | null }>
  }>
}

type BoatSdk = {
  BoatApi: new (configuration: unknown) => BoatClient
  Configuration: new (p: { basePath?: string; accessToken?: string }) => unknown
}

/** The fix for a project without the SDK. */
export const INSTALL_SDK = `Install the Boat SDK in this project: npm i ${BOAT_SDK}`

const missing = (error: unknown) =>
  (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' ||
  (error as { code?: string }).code === 'MODULE_NOT_FOUND'

let loaded: Promise<BoatSdk> | undefined
/**
 * The Boat SDK, from beside reeval or else from the project: a package manager that doesn't link
 * peers into reeval's own `node_modules` still has it in the project's.
 */
export function loadBoatSdk(projectRoot = process.cwd()): Promise<BoatSdk> {
  loaded ??= (async () => {
    try {
      return (await import(BOAT_SDK)) as BoatSdk
    } catch (error) {
      if (!missing(error)) throw error
    }
    try {
      const path = createRequire(join(projectRoot, 'noop.js')).resolve(BOAT_SDK)
      return (await import(pathToFileURL(path).href)) as BoatSdk
    } catch (error) {
      if (!missing(error)) throw error
      throw new PrepareError({
        class: 'config',
        stage: 'boat',
        ref: null,
        cause: null,
        log: null,
        usage: true,
        message: `boat() needs the Boat SDK, which isn't installed. ${INSTALL_SDK}`,
      })
    }
  })()
  loaded.catch(() => {
    loaded = undefined
  })
  return loaded
}

/** Why `sandbox`'s key can't be read from this process's environment, or null. */
export function boatKeyProblem(sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>): string | null {
  const name = sandbox.apiKey.from
  const value = process.env[name]
  if (!value) return `boat() needs a Boat API key in ${name}, which isn't set`
  if (/\s/.test(value)) {
    return `${name} has whitespace or a line break in it (a key pasted from a wrapped line?); set it to the key alone`
  }
  return null
}

/** A client for `sandbox`'s account; the key goes from the environment to the SDK, nowhere else. */
export async function boatClient(
  sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>,
  projectRoot?: string,
): Promise<BoatClient> {
  const problem = boatKeyProblem(sandbox)
  if (problem) {
    throw new PrepareError({
      class: 'config',
      stage: 'boat',
      ref: null,
      cause: null,
      log: null,
      usage: true,
      message: `${problem}. Set it in the environment or the project's .env.local.`,
    })
  }
  const { BoatApi, Configuration } = await loadBoatSdk(projectRoot)
  const basePath = process.env[BOAT_BASE_URL]
  const accessToken = process.env[sandbox.apiKey.from]
  // A variable whose name doesn't look secret (`BOAT_PROD`) isn't masked by name.
  registerSecret(accessToken)
  return new BoatApi(
    new Configuration({
      accessToken,
      ...(basePath ? { basePath } : {}),
    }),
  )
}

/** What Boat said about a failed call: `404 not_found: …`, or the error's own message. */
export async function boatError(error: unknown): Promise<string> {
  const response = (error as { response?: Response }).response
  if (!response) return error instanceof Error ? error.message : String(error)
  const body = await response.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } | string }
    const e = parsed.error
    if (typeof e === 'string') detail = e
    else if (e) detail = [e.code, e.message].filter(Boolean).join(': ')
  } catch {}
  return `${response.status}${detail ? ` ${detail}` : ''}`
}

const status = (error: unknown) => (error as { response?: Response }).response?.status

/** The part of every sandbox name that says which run made it. */
export const runTag = (runId: string) =>
  createHash('sha256').update(runId).digest('hex').slice(0, 8)

/** `<prefix>-<run>-`: what every sandbox of the run is named with first. */
export const runPrefix = (sandbox: Pick<BoatSandboxDescriptor, 'prefix'>, runId: string) =>
  `${sandbox.prefix}-${runTag(runId)}-`

/** How long a created sandbox may take to be ready. */
const READY_TIMEOUT_MS = 120_000
/** How long a check of the account may wait on Boat, so an unreachable API can't stall a plan. */
const LIMITS_TIMEOUT_MS = 15_000
/** How long a run's cleanup may wait on one account, so an unreachable API can't stall a resume. */
const CLEANUP_TIMEOUT_MS = 15_000
/** Boat's states a sandbox never leaves for `ready`; 'cancelled' answers 404 after it's reported. */
export const DEAD_STATES = ['archived', 'archiving', 'error', 'cancelled']
/** Past the attempt's timeout, so a sandbox whose worker was killed still goes away by itself. */
const TTL_MARGIN_S = 600
/**
 * How long reeval keeps deleting a sandbox that never got ready: Boat can drop a delete sent while
 * it provisions and bring the VM up idle minutes later.
 */
const UNREADY_DELETE_MS = 10 * 60_000

async function untilReady(
  api: BoatClient,
  id: string,
  signal: AbortSignal,
): Promise<BoatSandboxInfo> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const { sandbox } = await api.get({ sandboxId: id }).catch(async (error: unknown) => {
      throw new InfraError(`Boat didn't report sandbox ${id}: ${await boatError(error)}`)
    })
    if (['ready', 'idle', 'running'].includes(sandbox.state)) return sandbox
    if (DEAD_STATES.includes(sandbox.state)) {
      throw new InfraError(
        `Boat sandbox ${id} stopped starting: ${sandbox.state}${sandbox.error ? ` (${sandbox.error})` : ''}`,
      )
    }
    if (Date.now() > deadline) {
      throw new InfraError(
        `Boat sandbox ${id} wasn't ready after ${READY_TIMEOUT_MS / 1000}s (still ${sandbox.state})`,
      )
    }
    if (signal.aborted) throw signal.reason
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/** Deletes a sandbox; one already gone is deleted. */
async function deleteSandbox(api: BoatClient, id: string, signal?: AbortSignal): Promise<void> {
  try {
    await api.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }, { signal })
  } catch (error) {
    if (status(error) !== 404) throw error
  }
}

/**
 * Deletes a sandbox that never got ready, sending the delete again every `redeleteMs` until Boat
 * answers 404 or reports one of {@link DEAD_STATES}, for at most `deadlineMs`. Once `signal` is
 * aborted it sends the delete once and stops: a canceled run's `cleanupRun` and the sandbox's TTL
 * take it from there, so the cancel doesn't wait on Boat. Whether it went.
 */
export async function deleteUntilGone(
  api: BoatClient,
  id: string,
  o: { deadlineMs?: number; pollMs?: number; redeleteMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const until = Date.now() + (o.deadlineMs ?? UNREADY_DELETE_MS)
  const pollMs = o.pollMs ?? 5_000
  const redeleteMs = o.redeleteMs ?? 30_000
  let deletedAt = Number.NEGATIVE_INFINITY
  for (;;) {
    if (Date.now() - deletedAt >= redeleteMs) {
      await deleteSandbox(api, id).catch(() => {})
      deletedAt = Date.now()
    }
    if (o.signal?.aborted) return false
    const state = await api.get({ sandboxId: id }).then(
      ({ sandbox }) => sandbox.state,
      (error: unknown) => (status(error) === 404 ? null : 'unknown'),
    )
    if (state === null || DEAD_STATES.includes(state)) return true
    if (Date.now() >= until || o.signal?.aborted) return false
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, pollMs)
      o.signal?.addEventListener('abort', done, { once: true })
    })
  }
}

/** A fresh ed25519 key pair in `dir`, made by the host's OpenSSH. */
async function newKey(dir: string): Promise<{ file: string; pub: string }> {
  const file = join(dir, 'id_ed25519')
  const made = await run('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'reeval',
    '-f',
    file,
  ])
  if (made.exitCode !== 0) {
    throw new InfraError(
      `Couldn't make an SSH key for the Boat sandbox: ssh-keygen failed: ${made.stderr.trim()}`,
    )
  }
  return { file, pub: (await readFile(`${file}.pub`, 'utf8')).trim() }
}

/** A host and port the attempt's SSH connection can take to the VM's sshd. */
type SshRoute = { host: string; port: number; via: 'machine address' | 'public endpoint' }

/**
 * Where a sandbox's sshd answers, best first: the VM's own address on port 22, then the public
 * endpoint Boat forwards. The address is IPv6, which a host without IPv6 can't reach; the endpoint
 * is NAT'd, which another VM on the same Boat host can't reach.
 */
export function sshRoutes(reply: BoatSshReply): SshRoute[] {
  const routes: SshRoute[] = []
  if (reply.machineIp) routes.push({ host: reply.machineIp, port: 22, via: 'machine address' })
  const endpoint = /^(.+):(\d+)$/.exec(reply.sshEndpoint ?? '')
  if (endpoint) {
    const host = (endpoint[1] as string).replace(/^\[(.*)\]$/, '$1')
    routes.push({ host, port: Number(endpoint[2]), via: 'public endpoint' })
  }
  return routes
}

const routeLabel = (r: SshRoute) =>
  `${isIPv6(r.host) ? `[${r.host}]` : r.host}:${r.port} (${r.via})`

/** How long one try at a route may take to greet, so an address that drops packets costs little. */
const PROBE_MS = 3_000
/** How long the VM may take, after it reports ready, to greet on any route. */
const REACH_MS = 60_000

/** Whether `route` greets with an SSH banner within `timeoutMs`, or why not. */
function probe(route: SshRoute, timeoutMs: number, signal: AbortSignal): Promise<true | string> {
  return new Promise((resolve) => {
    const socket = connect({ host: route.host, port: route.port })
    let banner = ''
    const done = (result: true | string) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      socket.destroy()
      resolve(result)
    }
    const stop = () => done('not needed')
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => done(`no SSH greeting in ${timeoutMs / 1000}s`), timeoutMs)
    socket.on('data', (d: Buffer) => {
      banner += d.toString('latin1')
      if (banner.startsWith('SSH-')) done(true)
      else if (banner.length >= 4) done('answered, but not as SSH')
    })
    socket.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? e.message))
    socket.on('close', () => done('closed before an SSH greeting'))
  })
}

/**
 * The first of `routes`, in order, whose sshd greets: each round tries them all at once and takes
 * the best that answered, so a route this host can't use costs at most one probe. A VM that just
 * reported ready may not greet yet, so rounds repeat until `reachMs` has passed.
 */
export async function firstReachable(
  routes: readonly SshRoute[],
  o: { probeMs?: number; reachMs?: number; signal?: AbortSignal } = {},
): Promise<{ route: SshRoute } | { why: string }> {
  const probeMs = o.probeMs ?? PROBE_MS
  const deadline = Date.now() + (o.reachMs ?? REACH_MS)
  for (;;) {
    const round = new AbortController()
    const tries = routes.map((r) => probe(r, probeMs, round.signal))
    const results: Array<true | string> = []
    for (const [i, attempt] of tries.entries()) {
      results.push(await attempt)
      if (results[i] === true) {
        round.abort()
        return { route: routes[i] as SshRoute }
      }
    }
    if (Date.now() >= deadline || o.signal?.aborted) {
      return { why: routes.map((r, i) => `${routeLabel(r)}: ${results[i]}`).join('; ') }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** Where the agent's Node lives when the VM's own is somewhere the sandbox user can't read. */
const AGENT_NODE = '/opt/reeval/node'
/**
 * Boat's `/usr/local/bin/node` links into the login user's nvm, under a home other users can't
 * enter: give the sandbox user its own copy of that Node, whose version the record names.
 */
const NODE_FOR_AGENT = [
  'real="$(readlink -f "$(command -v node)" 2>/dev/null || true)"',
  `{ [ -z "$real" ] || sudo -n -u ${SANDBOX_USER} test -x "$real" || { rm -rf ${AGENT_NODE} && mkdir -p ${AGENT_NODE} && cp -a "$(dirname "$(dirname "$real")")/." ${AGENT_NODE} && chmod -R a+rX ${AGENT_NODE}; }; }`,
].join(' && ')

export async function createBoatSandbox(
  descriptor: BoatSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  const api = await boatClient(descriptor).catch((error: unknown) => {
    throw error instanceof PrepareError ? new InfraError(error.message) : error
  })
  const debug = attemptDebug()
  const type = descriptor.type ?? 'small'
  const name = `${runPrefix(descriptor, options.runId)}${randomBytes(3).toString('hex')}`
  return startSandbox(options, {
    helper: 'boat()',
    install: true,
    networkNote: `network policy ${egressLabel(options.egress) || 'allow-all'} · the VM keeps its own network, so traffic that ignores the proxy goes out directly, unrecorded`,
    async boot() {
      const started = performance.now()
      const dir = await mkdtemp(join(tmpdir(), 'reeval-boat-'))
      let id: string | undefined
      let ready = false
      const remove = async () => {
        if (id && ready) await deleteSandbox(api, id).catch(() => {})
        else if (id) await deleteUntilGone(api, id, { signal: options.signal }).catch(() => {})
        await rm(dir, { recursive: true, force: true })
      }
      try {
        const key = await newKey(dir)
        const made = await api
          .create({
            idempotencyKey: name,
            createSandboxRequest: {
              type,
              name,
              ttlSeconds: Math.ceil(options.timeoutMs / 1000) + TTL_MARGIN_S,
              noEnv: true,
              snapshots: false,
              monitoring: false,
            },
          })
          .catch(async (error: unknown) => {
            throw new InfraError(`Boat didn't create a sandbox: ${await boatError(error)}`)
          })
        id = made.sandbox.id
        await untilReady(api, id, options.signal)
        ready = true
        const ssh = await api
          .sshKey({ sandboxId: id, sshKeyRequest: { key: key.pub } })
          .catch(async (error: unknown) => {
            throw new InfraError(
              `Boat didn't authorize the attempt's SSH key: ${await boatError(error)}`,
            )
          })
        const routes = sshRoutes(ssh)
        if (!routes.length || !ssh.hostKey) {
          throw new InfraError(
            `Boat gave sandbox ${id} no SSH address and host key to connect with`,
          )
        }
        const knownHostsFile = join(dir, 'known_hosts')
        await writeFile(knownHostsFile, `${id} ${ssh.hostKey.trim()}\n`)
        debug?.log(
          'container',
          `created ${id} (${name}, ${type}) in ${Math.round(performance.now() - started)}ms`,
        )
        const reachStarted = performance.now()
        const reached = await firstReachable(routes, { signal: options.signal })
        if (options.signal.aborted) throw options.signal.reason
        if ('why' in reached) {
          throw new InfraError(
            `Boat sandbox ${id} is up, but this host can't reach its SSH server: ${reached.why}`,
          )
        }
        debug?.log(
          'container',
          `ssh to ${id} over ${routeLabel(reached.route)}, found in ${Math.round(performance.now() - reachStarted)}ms`,
        )
        const machine = await connectSsh({
          target: {
            host: reached.route.host,
            port: reached.route.port,
            user: ssh.sshUser ?? 'user',
            identityFile: key.file,
            knownHostsFile,
            hostKeyAlias: id,
            controlPath: join(dir, 'cm'),
          },
          description: `boat sandbox ${id} (${type})`,
          env: options.env,
          path: [`${AGENT_NODE}/bin`],
          prepare: NODE_FOR_AGENT,
          abortSignal: options.signal,
        })
        return {
          root: machine.root,
          session: machine.session,
          async destroy() {
            await machine.close()
            await remove()
          },
        }
      } catch (error) {
        await remove()
        throw error
      }
    },
  })
}

/** Every sandbox on `sandbox`'s account whose name starts with `prefix`, across pages. */
async function sandboxesNamed(
  api: BoatClient,
  prefix: string,
  signal: AbortSignal,
): Promise<BoatSandboxInfo[]> {
  const found: BoatSandboxInfo[] = []
  let cursor: string | undefined
  do {
    const page = await api.sandboxes(
      { namePrefix: prefix, limit: 100, ...(cursor && { cursor }) },
      { signal },
    )
    found.push(...page.sandboxes.filter((s) => s.name.startsWith(prefix)))
    cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined
  } while (cursor)
  return found
}

/**
 * Deletes every sandbox the run left on each account and prefix in `sandboxes`. Nothing else
 * names them: another prefix, or another run's tag, is someone else's.
 */
export async function removeRunSandboxes(
  runId: string,
  sandboxes: readonly BoatSandboxDescriptor[],
): Promise<void> {
  const seen = new Set<string>()
  for (const sandbox of sandboxes) {
    const prefix = runPrefix(sandbox, runId)
    const key = `${sandbox.apiKey.from}\0${prefix}`
    if (seen.has(key) || boatKeyProblem(sandbox)) continue
    seen.add(key)
    const api = await boatClient(sandbox).catch(() => null)
    if (!api) continue
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    const left = await sandboxesNamed(api, prefix, signal).catch(() => [])
    await Promise.all(left.map((s) => deleteSandbox(api, s.id, signal).catch(() => {})))
  }
}

/** Machines Boat would still start for the account: its cap on sandboxes at once, less what's running. */
export async function boatCapacity(sandbox: BoatSandboxDescriptor): Promise<number | null> {
  const api = await boatClient(sandbox).catch(() => null)
  const limits = await api
    ?.limits({}, { signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
    .catch(() => null)
  return limits ? Math.max(0, limits.maxActiveSandboxes - limits.activeSandboxes) : null
}

/** The host's OpenSSH tools a Boat sandbox runs on, or the first one missing. */
export async function missingSshTool(): Promise<string | null> {
  for (const [tool, args] of [
    ['ssh', ['-V']],
    ['ssh-keygen', ['-?']],
  ] as const) {
    const r = await run(tool, [...args]).catch(() => null)
    if (!r) return tool
  }
  return null
}

/**
 * Preflight's check of one account: the host has OpenSSH, the key is set, the SDK loads, Boat
 * takes the key and would start the machine size asked for.
 */
export async function checkBoat(sandbox: BoatSandboxDescriptor, projectRoot: string) {
  const refuse = (message: string, usage: boolean) =>
    new PrepareError({
      class: 'config',
      stage: 'boat',
      ref: null,
      cause: null,
      log: null,
      usage,
      message,
    })
  const tool = await missingSshTool()
  if (tool) {
    throw refuse(
      `boat() runs every command over SSH, and there's no ${tool} on PATH: install an OpenSSH client (openssh-client on Debian and Ubuntu)`,
      true,
    )
  }
  const api = await boatClient(sandbox, projectRoot)
  const limits = await api
    .limits({}, { signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
    .catch(async (error: unknown) => {
      const code = status(error)
      if (code === 401 || code === 403) {
        throw refuse(
          `Boat refused the API key in ${sandbox.apiKey.from}: ${await boatError(error)}`,
          true,
        )
      }
      throw new PrepareError({
        class: 'transient',
        stage: 'boat',
        ref: null,
        cause: null,
        log: null,
        message: `Couldn't reach Boat: ${await boatError(error)}`,
      })
    })
  const type = sandbox.type ?? 'small'
  const machine = limits.machineTypes?.find((m) => m.type === type)
  if (machine && !machine.available) {
    throw refuse(
      `Boat won't start a ${type} machine on this account: ${machine.reason ?? 'unavailable'}`,
      true,
    )
  }
  if (!limits.canStart) {
    throw refuse(
      `Boat won't start sandboxes on this account: ${limits.startBlockedReason ?? 'no reason given'}`,
      false,
    )
  }
}

/** `reeval doctor`: the OpenSSH client, and each Boat account and machine size `sandboxes` use. */
export async function boatDoctor(
  sandboxes: readonly BoatSandboxDescriptor[],
  ctx: DoctorContext,
): Promise<Check[]> {
  const accounts = new Map<string, BoatSandboxDescriptor>()
  for (const sandbox of sandboxes) {
    accounts.set(`${sandbox.apiKey.from}\0${sandbox.type ?? 'small'}`, sandbox)
  }
  if (!accounts.size) return []
  const missing = await ctx.deps.missingSshTool()
  const checks: Check[] = [
    missing
      ? {
          id: 'ssh',
          status: 'fail',
          summary: `boat() runs every command over SSH, and there's no ${missing} on PATH`,
          fix: 'install an OpenSSH client (openssh-client on Debian and Ubuntu)',
        }
      : { id: 'ssh', status: 'ok', summary: 'an OpenSSH client for boat()' },
  ]
  for (const sandbox of accounts.values()) {
    const key = sandbox.apiKey.from
    const type = sandbox.type ?? 'small'
    if (!ctx.deps.env[key]) {
      checks.push({
        id: 'boat',
        status: 'fail',
        summary: `boat() needs a Boat API key in ${key}, which isn't set`,
        fix: `set ${key} in ${ctx.envFile}`,
      })
      continue
    }
    try {
      await ctx.deps.boatAccount(sandbox, ctx.root, ctx.online)
      checks.push({
        id: 'boat',
        status: 'ok',
        summary: ctx.online
          ? `Boat takes the key in ${key} and starts ${type} machines`
          : `the Boat SDK loads, and ${key} is set (--online asks Boat whether it takes the key)`,
      })
    } catch (error) {
      checks.push({
        id: 'boat',
        status: 'fail',
        summary: redactSecrets((error as Error).message),
      })
    }
  }
  return checks
}
