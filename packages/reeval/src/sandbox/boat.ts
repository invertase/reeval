// boat.dev VMs as sandboxes: Boat's API (@reeval/vm-api, over @boatdev/sdk) creates and deletes them, and
// every process runs over SSH with a per-attempt key, the egress gateway's forwarder included, so
// credentials stay on the host as they do for Docker.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, isIPv6 } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as BoatSdkModule from '@boatdev/sdk'
import {
  removeUntilGone,
  type SshRoute,
  VmApiError,
  type VmInfo,
  type VmLimits,
  VmNotReady,
  waitReady,
} from '@reeval/vm-api'
import { type BoatVmApi, boatApi } from '@reeval/vm-api/boat'
import type { Check } from '../doctor.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import { hostEnv } from '../secrets-file.ts'
import type { BoatSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import type { DoctorContext } from './kinds.ts'
import { SANDBOX_LABELS, sandboxLabels } from './labels.ts'
import type { OpenPool } from './machine-service.ts'
import { optionalPeer } from './optional-peer.ts'
import type { PoolProvider } from './pool.ts'
import { PrepareError } from './provider.ts'
import { recipeOf } from './recipe.ts'
import {
  createPooledSshSandbox,
  missingSshTool,
  newKey,
  type PooledSshMachine,
  TTL_MARGIN_S,
} from './ssh-pool.ts'
import { InfraError, MachineReclaimed, type NetworkSandbox, RunStopped } from './types.ts'

export const BOAT_BASE_URL = 'BOAT_BASE_URL'

/**
 * Whose API the VMs come from, as messages and the record name it: Boat's own for `boat()`, or
 * `cloud()`'s, on the same client under another name.
 */
export type VmService = {
  /** How messages name the sandbox: `boat()`. */
  helper: string
  /** The record's provider and preflight's stage: `boat`. */
  kind: string
  /** How messages name who runs the VMs: `Boat`. */
  name: string
  /** How a refusal names the credential: `the API key in BOAT_API_KEY`. */
  credential: string
  /** What its caps hold to, as refusals name it: `account`. */
  scope: 'account' | 'run'
  /**
   * What `/limits`' hourly start cap counts: starts in any hour, or every start the run may make,
   * which never comes back.
   */
  starts: 'per hour' | 'per run'
  /** The most labels a create takes, reeval's own included. */
  maxLabels: number
  /** The start of the label keys the service keeps for itself and refuses on a create. */
  reservedLabels?: string
  /** Why a credential that worked at preflight can be refused later: `; it expired …`. */
  expiry?: string
  /** Why the service can grant a machine less time than asked: `; it …`. */
  ttlLimit?: string
  /**
   * A refused start is waited on for as long as the service asks, and only a `409` with one of
   * these codes, which says the service ended the run, stops the run's attempts.
   */
  endsRun?: readonly string[]
  /**
   * The spec `spec` becomes under the layout the service's `/limits` names, which decides the
   * machine type, reuse and attempts per machine in place of the eval's; null, for no layout or
   * one it can't read, keeps `spec`.
   */
  laidOut?(spec: VmSpec, layout: unknown): VmSpec | null
  /**
   * The `409` code a keep-alive answers with when the service takes a reused machine back before
   * its next attempt, which the pool gives up without counting it a failure.
   */
  reclaims?: string
}

/** What a pool of the service's machines is asked for. */
export type VmSpec = {
  /** The start of every machine's name. */
  prefix: string
  /** The machine type the API takes. */
  type: string
  /** The size the record names. */
  size: string
  maxConcurrent?: number
  reuse?: boolean
  attemptsPerMachine?: number
  /** The saved snapshot each machine starts from, rather than the service's own base. */
  from?: string
}

export const boatService = (sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>): VmService => ({
  helper: 'boat()',
  kind: 'boat',
  name: 'Boat',
  credential: `the API key in ${sandbox.apiKey.from}`,
  scope: 'account',
  starts: 'per hour',
  maxLabels: 20,
})

const boatSpec = (sandbox: BoatSandboxDescriptor): VmSpec => ({
  prefix: sandbox.prefix,
  type: sandbox.type ?? 'small',
  size: sandbox.type ?? 'small',
  ...(sandbox.maxConcurrent !== undefined && { maxConcurrent: sandbox.maxConcurrent }),
  ...(sandbox.reuse !== undefined && { reuse: sandbox.reuse }),
  ...(sandbox.attemptsPerMachine !== undefined && {
    attemptsPerMachine: sandbox.attemptsPerMachine,
  }),
})

/** The Boat calls reeval makes: {@link boatApi}'s. */
export type BoatClient = BoatVmApi

export const BOAT_SDK = '@boatdev/sdk'

/** The part of the Boat SDK reeval constructs; {@link boatApi} makes the calls. */
export type BoatSdk = Pick<typeof BoatSdkModule, 'BoatApi' | 'Configuration'>

/** The fix for a project without the SDK. */
export const INSTALL_SDK = `Install the Boat SDK in this project: npm i ${BOAT_SDK}`

/**
 * The Boat SDK, from beside reeval or else from the project: a package manager that doesn't link
 * peers into reeval's own `node_modules` still has it in the project's.
 */
export const loadBoatSdk = optionalPeer<BoatSdk>(BOAT_SDK, {
  stage: 'boat',
  message: `boat() needs the Boat SDK, which isn't installed. ${INSTALL_SDK}`,
})

/** `sdk`'s client at `basePath` (the SDK's own unless set) as reeval's {@link BoatClient}. */
export const boatClientOf = (sdk: BoatSdk, accessToken: string, basePath?: string): BoatClient =>
  boatApi(
    new sdk.BoatApi(new sdk.Configuration({ accessToken, ...(basePath ? { basePath } : {}) })),
  )

const boatClientOrNull = (sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>) =>
  boatClient(sandbox).catch(() => null)

/** Why `sandbox`'s key can't be read from this process's environment, or null. */
export function boatKeyProblem(sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>): string | null {
  const name = sandbox.apiKey.from
  const value = hostEnv()[name]
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
  const sdk = await loadBoatSdk(projectRoot)
  const accessToken = hostEnv()[sandbox.apiKey.from] as string
  // A variable whose name doesn't look secret (`BOAT_PROD`) isn't masked by name.
  registerSecret(accessToken)
  return boatClientOf(sdk, accessToken, process.env[BOAT_BASE_URL])
}

/** What Boat said about a failed call: `404 not_found: …`, or the error's own message. */
export function boatError(error: unknown): string {
  if (error instanceof VmApiError) return error.detail
  return error instanceof Error ? error.message : String(error)
}

const status = (error: unknown) => (error instanceof VmApiError ? error.status : undefined)

/**
 * The attempt can't finish on a machine granted `granted` seconds of the `asked` it asked for,
 * which leaves `TTL_MARGIN_S` for teardown: an error saying so, rather than the machine stopping
 * mid-attempt.
 */
function tooShort(service: VmService, id: string, asked: number, granted?: number | null) {
  const needs = asked - TTL_MARGIN_S
  if (typeof granted !== 'number' || granted >= needs) return null
  return new InfraError(
    `${service.name} gave sandbox ${id} ${granted}s to live, and the attempt needs ${needs}s, its timeout and setup${service.ttlLimit ?? ''}`,
  )
}

/** `error` from `doing` as an attempt's infra error, a refused credential saying so. */
function serviceFailed(service: VmService, error: unknown, doing: string, why?: string) {
  why ??= boatError(error)
  if (status(error) === 401) {
    return new InfraError(
      `${service.name} refused ${service.credential}${service.expiry ?? ''}: ${why}`,
    )
  }
  return new InfraError(`${service.name} ${doing}: ${why}`)
}

/** The part of every sandbox name that says which run made it. */
export const runTag = (runId: string) =>
  createHash('sha256').update(runId).digest('hex').slice(0, 8)

/** `<prefix>-<run>-`: what every sandbox of the run is named with first. */
export const runPrefix = (sandbox: Pick<BoatSandboxDescriptor, 'prefix'>, runId: string) =>
  `${sandbox.prefix}-${runTag(runId)}-`

/** The labels every sandbox of the run carries, beside those {@link sandboxLabels} adds. */
export const runLabels = (sandbox: { prefix: string }, runId: string) => ({
  'reeval-prefix': sandbox.prefix,
  'reeval-run': runTag(runId),
})

/** How long a created sandbox may take to be ready. */
const READY_TIMEOUT_MS = 120_000
/** How long a check of the account may wait on Boat, so an unreachable API can't stall a plan. */
const LIMITS_TIMEOUT_MS = 15_000
/** How long a run's cleanup may wait on one account, so an unreachable API can't stall a resume. */
const CLEANUP_TIMEOUT_MS = 15_000
/**
 * How long reeval keeps deleting a sandbox that never got ready: Boat can drop a delete sent while
 * it provisions and bring the VM up idle minutes later.
 */
const UNREADY_DELETE_MS = 10 * 60_000

async function untilReady(service: VmService, api: BoatClient, id: string, signal: AbortSignal) {
  try {
    return await waitReady(api, id, { timeoutMs: READY_TIMEOUT_MS, signal })
  } catch (error) {
    if (error instanceof VmNotReady) throw new InfraError(`${service.name} ${error.message}`)
    if (signal.aborted) throw error
    throw serviceFailed(service, error, `didn't report sandbox ${id}`)
  }
}

/**
 * Deletes a sandbox that never got ready, sending the delete again until Boat answers 404 or
 * reports a dead state, for at most 10 minutes. Once `signal` is aborted it sends the delete once
 * and stops: a canceled run's `cleanupRun` and the sandbox's TTL take it from there, so the cancel
 * doesn't wait on Boat. Whether it went.
 */
export const deleteUntilGone = (
  api: BoatClient,
  id: string,
  o: { signal?: AbortSignal } = {},
): Promise<boolean> => removeUntilGone(api, id, { deadlineMs: UNREADY_DELETE_MS, ...o })

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

/** Boat refused a start for now: 429, with when to try again if it said. */
export class BoatRateLimited extends Error {
  readonly retryAfterMs: number | null
  constructor(message: string, retryAfterMs: number | null) {
    super(message)
    this.name = 'BoatRateLimited'
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A pool on the account: Boat's start caps (the paid ceilings when the account pays for starts
 * past its plan), less the hour's starts already made, and the machines it would still run, are
 * the account's limits; `maxConcurrent` caps the pool's own machines.
 */
export const openBoatPool: OpenPool<BoatSandboxDescriptor> = async (sandbox, o) =>
  openVmPool(
    boatService(sandbox),
    { ...boatSpec(sandbox), ...(typeof o.image === 'string' && { from: o.image }) },
    await boatClient(sandbox, o.root),
    o.runId,
  )

/**
 * The pool of `asked`'s machines on `api`, laid out as the service's limits say where it lays them
 * out, within the start caps and machines its limits allow.
 */
export async function openVmPool(
  service: VmService,
  asked: VmSpec,
  api: BoatClient,
  runId: string,
): ReturnType<OpenPool<BoatSandboxDescriptor>> {
  const limits = await readLimits(service, api)
  const spec = laidOut(service, asked, limits)
  const k = spec.attemptsPerMachine ?? 1
  const free = limits ? Math.max(1, limits.maxLive - limits.live) : 1
  const hourUsed = limits?.startsThisHour ?? 0
  const left = limits?.startsPerHour === undefined ? null : limits.startsPerHour - hourUsed
  return {
    provider: vmPoolProvider(service, spec, api, runId),
    options: {
      limits: {
        machines: free,
        startsPerMinute: limits?.startsPerMinute ?? null,
        ...(service.starts === 'per run'
          ? { startsPerHour: null, starts: left === null ? null : Math.max(0, left) }
          : { startsPerHour: left === null ? null : Math.max(1, left) }),
      },
      ...(spec.maxConcurrent && { machines: Math.ceil(spec.maxConcurrent / k) }),
      ...(service.endsRun && { maxRateWaitMs: Number.POSITIVE_INFINITY }),
      attemptsPerMachine: k,
      reuse: spec.reuse ?? false,
    },
  }
}

/** `spec` under the layout `limits` names, for a service that lays its machines out. */
function laidOut(service: VmService, spec: VmSpec, limits: { layout?: unknown } | null): VmSpec {
  return (limits?.layout !== undefined && service.laidOut?.(spec, limits.layout)) || spec
}

const limitsWarned = new Set<string>()

/**
 * The account's limits, or null, warning once, when the service doesn't answer: the pool then
 * runs one machine with no start caps of its own, holding back only when a start is refused.
 */
async function readLimits(service: VmService, api: BoatClient | null): Promise<VmLimits | null> {
  try {
    if (!api) throw new Error(`no ${service.name} client`)
    return await api.limits({ signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
  } catch (error) {
    if (!limitsWarned.has(service.kind)) {
      limitsWarned.add(service.kind)
      console.warn(
        `warning: ${service.helper} couldn't read the account's limits (${(error as Error)?.message ?? error}), so the run starts one machine at a time and runs its attemptsPerMachine attempts on it`,
      )
    }
    return null
  }
}

/** Starting, keeping and removing `spec`'s machines for the run's pool, in the main process. */
export function vmPoolProvider(
  service: VmService,
  spec: VmSpec,
  api: BoatClient,
  runId: string,
): PoolProvider<PooledSshMachine> {
  const { type, size } = spec
  const labels = { ...sandboxLabels(), ...runLabels(spec, runId) }
  const dirs = new Map<string, string>()
  return {
    helper: service.helper,
    rateLimited: (error) =>
      error instanceof BoatRateLimited ? { retryAfterMs: error.retryAfterMs } : null,
    async keepAlive(id, ttlSeconds) {
      const updated = await api.setTtl(id, ttlSeconds).catch((error: unknown) => {
        const code = error instanceof VmApiError ? error.code : null
        if (status(error) === 409 && code && code === service.reclaims) {
          throw new MachineReclaimed(`${service.name} took sandbox ${id} back: ${boatError(error)}`)
        }
        if (status(error) === 409 && code && service.endsRun?.includes(code)) {
          throw new RunStopped(
            `${service.name} ended the run, so its machines take no more attempts: ${boatError(error)}`,
          )
        }
        throw error
      })
      const short = tooShort(service, id, ttlSeconds, updated.ttlSeconds)
      if (short) throw short
    },
    async remove(id) {
      await api.remove(id).catch(() => {})
      const dir = dirs.get(id)
      dirs.delete(id)
      if (dir) await rm(dir, { recursive: true, force: true })
    },
    async start(signal, ttlSeconds) {
      const name = `${runPrefix(spec, runId)}${randomBytes(3).toString('hex')}`
      const vm = await startVm(service, api, {
        name,
        type,
        size,
        ttlSeconds,
        snapshots: false,
        ...(spec.from !== undefined && { from: spec.from }),
        labels,
        signal,
      })
      dirs.set(vm.id, vm.dir)
      return {
        id: vm.id,
        info: {
          ...vm.info,
          attemptsPerMachine: spec.attemptsPerMachine ?? 1,
          reuse: spec.reuse ?? false,
        },
      }
    },
  }
}

/** A machine {@link startVm} started: its id, how to reach it, and its key's directory. */
export type StartedVm = { id: string; info: PooledSshMachine; dir: string }

/**
 * Creates a machine named `name`, waits until it's ready and reachable over SSH with a key of its
 * own, and returns it; one that fails on the way is deleted. The caller removes `dir` with it.
 */
export async function startVm(
  service: VmService,
  api: BoatClient,
  o: {
    name: string
    type: string
    size: string
    ttlSeconds: number
    /** Whether the machine can be saved as a snapshot. */
    snapshots: boolean
    /** The saved snapshot it starts from. */
    from?: string
    labels: Record<string, string>
    signal: AbortSignal
  },
): Promise<StartedVm> {
  const { name, type, size, ttlSeconds, signal } = o
  const dir = await mkdtemp(join(tmpdir(), `reeval-${service.kind}-`))
  let id: string | undefined
  let ready = false
  try {
    const key = await newKey(dir, service.name)
    const made = await api
      .create({
        idempotencyKey: name,
        size: type,
        name,
        ttlSeconds,
        saveable: o.snapshots,
        ...(o.from !== undefined && { from: o.from }),
        labels: o.labels,
      })
      .catch((error: unknown) => {
        const why = boatError(error)
        const code = error instanceof VmApiError ? error.code : null
        if (status(error) === 409 && code && service.endsRun?.includes(code)) {
          throw new RunStopped(
            `${service.name} ended the run, so it starts no more machines: ${why}`,
          )
        }
        if (status(error) === 429) {
          const at = error instanceof VmApiError ? error.retryAt : undefined
          throw new BoatRateLimited(
            `${service.name} is limiting starts: ${why}`,
            at === undefined ? null : Math.max(0, at - Date.now()),
          )
        }
        if (status(error) === 403) {
          throw new InfraError(
            `${service.name} won't start another sandbox for this ${service.scope}: ${why}`,
          )
        }
        throw serviceFailed(service, error, "didn't create a sandbox", why)
      })
    id = made.id
    const short = tooShort(service, id, ttlSeconds, made.ttlSeconds)
    if (short) throw short
    await untilReady(service, api, id, signal)
    ready = true
    const ssh = await api
      .sshAccess(id, { publicKey: key.pub, minutes: Math.ceil(ttlSeconds / 60) })
      .catch((error: unknown) => {
        throw serviceFailed(service, error, "didn't authorize the machine's SSH key")
      })
    const { routes } = ssh
    if (!routes.length || !ssh.hostKey) {
      throw new InfraError(
        `${service.name} gave sandbox ${id} no SSH address and host key to connect with`,
      )
    }
    const knownHostsFile = join(dir, 'known_hosts')
    await writeFile(knownHostsFile, `${id} ${ssh.hostKey}\n`)
    const reached = await firstReachable(routes, { signal })
    signal.throwIfAborted()
    if ('why' in reached) {
      throw new InfraError(
        `${service.name} sandbox ${id} is up, but this host can't reach its SSH server: ${reached.why}`,
      )
    }
    return {
      id,
      dir,
      info: {
        id,
        name,
        size,
        host: reached.route.host,
        port: reached.route.port,
        route: routeLabel(reached.route),
        user: ssh.user,
        identityFile: key.file,
        knownHostsFile,
      },
    }
  } catch (error) {
    if (id && ready) await api.remove(id).catch(() => {})
    else if (id) await deleteUntilGone(api, id, { signal }).catch(() => {})
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function createBoatSandbox(
  descriptor: BoatSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  if (recipeOf(descriptor)) {
    if (!options.base) {
      throw new InfraError("The boat() sandbox's image wasn't prepared before the run started")
    }
    const { createVmContainerSandbox } = await import('./vm-container.ts')
    return createVmContainerSandbox(descriptor, options.base, options, {
      fn: 'boat',
      sandbox: 'boat',
      size: 'small',
      description: (info) => `boat sandbox ${info.id} (${info.size})`,
    })
  }
  return createPooledSshSandbox(descriptor, options, {
    helper: 'boat()',
    sandbox: 'boat',
    size: descriptor.type ?? 'small',
    description: (info) => `boat sandbox ${info.id} (${info.size})`,
  })
}

/** Every sandbox on `sandbox`'s account whose name starts with `prefix`, across pages. */
async function sandboxesNamed(
  api: BoatClient,
  prefix: string,
  signal: AbortSignal,
): Promise<VmInfo[]> {
  const found: VmInfo[] = []
  for await (const vm of api.list({ namePrefix: prefix }, { signal })) {
    if (vm.name.startsWith(prefix)) found.push(vm)
  }
  return found
}

/** Deletes every sandbox on `api` whose name starts with `prefix`, waiting on it for so long. */
export async function removeNamed(api: BoatClient, prefix: string): Promise<void> {
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
  const left = await sandboxesNamed(api, prefix, signal).catch(() => [])
  await Promise.all(left.map((s) => api.remove(s.id, { signal }).catch(() => {})))
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
    const api = await boatClientOrNull(sandbox)
    if (api) await removeNamed(api, prefix)
  }
}

export const boatCapacity = async (sandbox: BoatSandboxDescriptor) =>
  vmCapacity(boatService(sandbox), boatSpec(sandbox), await boatClientOrNull(sandbox))

/**
 * Machines the service would still start for the account (its cap on sandboxes at once, less
 * what's running), and the attempts the run's pool keeps going on them: a minute's starts' worth
 * of machines at most, each running `attemptsPerMachine`.
 */
export async function vmCapacity(
  service: VmService,
  asked: VmSpec,
  api: BoatClient | null,
): Promise<{ machines: number; attempts: number }> {
  const limits = await readLimits(service, api)
  const spec = laidOut(service, asked, limits)
  const k = spec.attemptsPerMachine ?? 1
  if (!limits) return { machines: 1, attempts: Math.min(k, spec.maxConcurrent ?? k) }
  const machines = Math.max(0, limits.maxLive - limits.live)
  const perMinute = limits.startsPerMinute
  const attempts = Math.min(machines, perMinute ?? machines) * k
  return { machines, attempts: Math.max(1, Math.min(attempts, spec.maxConcurrent ?? attempts)) }
}

/**
 * Preflight's check of one account: the host has OpenSSH, the key is set, the SDK loads, Boat
 * takes the key and would start the machine size asked for.
 */
export const checkBoat = (sandbox: BoatSandboxDescriptor, projectRoot: string) =>
  checkVmService(boatService(sandbox), boatSpec(sandbox), () => boatClient(sandbox, projectRoot))

/**
 * Preflight's check of a service: the labels parse, the host has OpenSSH, `client` makes a client,
 * the service takes its credential and would start `spec`'s machine type.
 */
export async function checkVmService(
  service: VmService,
  spec: VmSpec,
  client: () => BoatClient | Promise<BoatClient>,
): Promise<void> {
  const refuse = (message: string, usage: boolean) =>
    new PrepareError({
      class: 'config',
      stage: service.kind,
      ref: null,
      cause: null,
      log: null,
      usage,
      message,
    })
  let labels: Record<string, string>
  try {
    labels = sandboxLabels()
  } catch (error) {
    throw refuse((error as Error).message, true)
  }
  const reserved = Object.keys(labels).find(
    (key) => service.reservedLabels && key.toLowerCase().startsWith(service.reservedLabels),
  )
  if (reserved) {
    throw refuse(
      `${SANDBOX_LABELS} sets ${reserved}, and keys starting ${service.reservedLabels} are ${service.name}'s own`,
      true,
    )
  }
  const own = Object.keys(runLabels(spec, 'run')).length
  if (Object.keys(labels).length + own > service.maxLabels) {
    throw refuse(
      `${SANDBOX_LABELS} sets more than the ${service.maxLabels - own} labels ${service.helper} takes beside reeval's own`,
      true,
    )
  }
  const tool = await missingSshTool()
  if (tool) {
    throw refuse(
      `${service.helper} runs every command over SSH, and there's no ${tool} on PATH: install an OpenSSH client (openssh-client on Debian and Ubuntu)`,
      true,
    )
  }
  const api = await client()
  const limits = await api
    .limits({ signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
    .catch((error: unknown) => {
      const code = status(error)
      if (code === 401 || code === 403) {
        throw refuse(`${service.name} refused ${service.credential}: ${boatError(error)}`, true)
      }
      throw new PrepareError({
        class: 'transient',
        stage: service.kind,
        ref: null,
        cause: null,
        log: null,
        message: `Couldn't reach ${service.name}: ${boatError(error)}`,
      })
    })
  const laid = laidOut(service, spec, limits)
  const machine = limits.sizes?.find((m) => m.size === laid.type)
  if (machine && !machine.available) {
    throw refuse(
      `${service.name} won't start a ${laid.size} machine on this ${service.scope}: ${machine.reason ?? 'unavailable'}`,
      true,
    )
  }
  if (!limits.canStart) {
    throw refuse(
      `${service.name} won't start sandboxes on this ${service.scope}: ${limits.blockedReason ?? 'no reason given'}`,
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
