// Daytona sandboxes: Daytona's SDK (an optional peer, imported only here) creates and deletes
// them in the run's main process, and every process runs over Daytona's SSH gateway with a token
// per machine, the egress gateway's forwarder included, so credentials stay on the host as they do
// for Docker.
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as DaytonaSdkModule from '@daytona/sdk'
import type { Daytona, Image, Resources, Sandbox, Snapshot } from '@daytona/sdk'
import { run } from '@reeval/sandbox-docker/process'
import { retryAtOf } from '@reeval/vm-api'
import type { Check } from '../doctor.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import { hostEnv } from '../secrets-file.ts'
import type { DaytonaSandboxDescriptor, DaytonaSize, HarnessDescriptor } from '../types.ts'
import { runLabels } from './boat.ts'
import { daytonaImage } from './daytona-image.ts'
import type { SandboxOptions } from './index.ts'
import type { DoctorContext } from './kinds.ts'
import { sandboxLabels } from './labels.ts'
import type { OpenPool } from './machine-service.ts'
import { optionalPeer } from './optional-peer.ts'
import { type PoolProvider, RATE_LIMIT_WAITS, type RateLimited } from './pool.ts'
import { type PrepareContext, type PreparedHandle, PrepareError } from './provider.ts'
import {
  createPooledSshSandbox,
  missingSshTool,
  newKey,
  type PooledSshMachine,
} from './ssh-pool.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

const DAYTONA_SDK = '@daytona/sdk'
/** Where the SDK sends its calls, when not Daytona's own API. */
export const DAYTONA_API_URL = 'DAYTONA_API_URL'

/** The fix for a project without the SDK. */
export const INSTALL_DAYTONA_SDK = `Install Daytona's SDK in this project: npm i ${DAYTONA_SDK}`

/** The part of Daytona's SDK reeval constructs. */
type DaytonaSdk = Pick<typeof DaytonaSdkModule, 'Daytona' | 'Image'>

/** Daytona's SDK, from beside reeval or else from the project. */
export const loadDaytonaSdk = optionalPeer<DaytonaSdk>(DAYTONA_SDK, {
  stage: 'daytona',
  message: `daytona() needs Daytona's SDK, which isn't installed. ${INSTALL_DAYTONA_SDK}`,
})

/** Why `sandbox`'s key can't be read from this process's environment, or null. */
export function daytonaKeyProblem(
  sandbox: Pick<DaytonaSandboxDescriptor, 'apiKey'>,
): string | null {
  const name = sandbox.apiKey.from
  const value = hostEnv()[name]
  if (!value) return `daytona() needs a Daytona API key in ${name}, which isn't set`
  if (/\s/.test(value)) {
    return `${name} has whitespace or a line break in it (a key pasted from a wrapped line?); set it to the key alone`
  }
  return null
}

const usage = (message: string) =>
  new PrepareError({
    class: 'config',
    stage: 'daytona',
    ref: null,
    cause: null,
    log: null,
    usage: true,
    message,
  })

/** A client for `sandbox`'s organization; the key goes from the environment to the SDK, nowhere else. */
export async function daytonaClient(
  sandbox: Pick<DaytonaSandboxDescriptor, 'apiKey'>,
  projectRoot?: string,
): Promise<Daytona> {
  const problem = daytonaKeyProblem(sandbox)
  if (problem) throw usage(`${problem}. Set it in the environment or the project's .env.local.`)
  const { Daytona } = await loadDaytonaSdk(projectRoot)
  const apiKey = hostEnv()[sandbox.apiKey.from]
  registerSecret(apiKey)
  const apiUrl = process.env[DAYTONA_API_URL]
  // Polling, not the SDK's event socket, which would hold the run's main process open.
  return new Daytona({ apiKey, useDeprecatedPolling: true, ...(apiUrl ? { apiUrl } : {}) })
}

const statusOf = (error: unknown) => (error as { statusCode?: number }).statusCode
const headerOf = (error: unknown, name: string): string | null => {
  const headers = (error as { headers?: unknown }).headers as
    | { get?(n: string): unknown; [k: string]: unknown }
    | undefined
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]
  return value == null ? null : String(value)
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Daytona refused a start for now: 429, with when to try again if it said. */
export class DaytonaRateLimited extends Error {
  readonly retryAfterMs: number | null
  constructor(message: string, retryAfterMs: number | null) {
    super(message)
    this.name = 'DaytonaRateLimited'
    this.retryAfterMs = retryAfterMs
  }
}

/** How long a 429 asks to wait, from its `Retry-After` or the time its message names, else null. */
function retryAfterMs(header: string | null, message: string): number | null {
  const now = Date.now()
  const at = retryAtOf(undefined, header, message, now)
  return at === undefined ? null : at - now
}

const rateLimited = (error: unknown, what: string) =>
  statusOf(error) === 429
    ? new DaytonaRateLimited(
        `Daytona is limiting ${what}: ${messageOf(error)}`,
        retryAfterMs(headerOf(error, 'retry-after'), messageOf(error)),
      )
    : null

/**
 * `call` again while Daytona answers 429, waiting as the pool waits out a refused start: its
 * `Retry-After`, else a backoff that doubles, for at most the pool's time.
 */
export async function whileLimited<T>(
  what: string,
  call: () => Promise<T>,
  signal?: AbortSignal,
  waits: { maxRateWaitMs: number; backoffMs: number; maxBackoffMs: number } = RATE_LIMIT_WAITS,
): Promise<T> {
  const startedAt = Date.now()
  let backoff = waits.backoffMs
  for (;;) {
    try {
      return await call()
    } catch (error) {
      const limited = rateLimited(error, what)
      if (!limited) throw error
      const wait = limited.retryAfterMs ?? backoff
      backoff = Math.min(backoff * 2, waits.maxBackoffMs)
      if (Date.now() - startedAt + wait > waits.maxRateWaitMs) throw limited
      await sleep(wait, undefined, { signal })
    }
  }
}

/** `work`, or `signal`'s reason as soon as it aborts; `orphan` gets what `work` gives after that. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, orphan: (value: T) => unknown) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.then(orphan, () => {})
      reject(signal.reason)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** The default snapshot of each size. */
export const snapshotOf = (sandbox: Pick<DaytonaSandboxDescriptor, 'size'>) =>
  `daytona-${sandbox.size ?? 'medium'}`

/** Each size's resources, as Daytona's default snapshot of that size has them. */
const RESOURCES: Record<DaytonaSize, Resources> = {
  small: { cpu: 1, memory: 1, disk: 3 },
  medium: { cpu: 2, memory: 4, disk: 8 },
  large: { cpu: 4, memory: 8, disk: 10 },
}
const resourcesOf = (size: DaytonaSize) => RESOURCES[size]

/** What a recipe's sandboxes start from, as preflight prepared it and the pool's key names it. */
export type DaytonaStart = {
  /** The image's name: its snapshot's, when there's one. */
  name: string
  /** The snapshot each sandbox starts from; unset when each create builds `dockerfile`. */
  snapshot?: string
  /** The Dockerfile each create builds, which Daytona's build cache keeps for a while. */
  dockerfile?: string
  /** The directory its `COPY` sources are in. */
  contextDir?: string
  /** The image has the harness, so a machine of its own needn't install it. */
  harnessBaked: boolean
}

const spell = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`

/** How long a snapshot another run is making may take before preflight stops waiting on it. */
export const SNAPSHOT_WAITS = { pollMs: 2_000, waitMs: 15 * 60_000, buildMs: 30 * 60_000 }

/** The SDK's `Image` of a Dockerfile, with the files its `COPY` lines name. */
export async function sdkImage(
  image: { dockerfile?: string; contextDir?: string },
  root: string,
): Promise<Image> {
  const { Image } = await loadDaytonaSdk(root)
  // The SDK's factories take a base image or a Dockerfile on disk beside its context; an empty
  // image (its private constructor) is the one that takes a whole Dockerfile and a context directory.
  const empty = new (Image as unknown as new () => Image)()
  return empty.dockerfileCommands([(image.dockerfile ?? '').trimEnd()], image.contextDir)
}

const failed = (o: {
  class: 'config' | 'transient'
  ref: string | null
  log?: string | null
  message: string
}) =>
  new PrepareError({
    class: o.class,
    stage: 'daytona',
    ref: o.ref,
    cause: null,
    log: o.log ?? null,
    message: o.message,
  })

/** Why Daytona's build failed, from the SDK's error: the snapshot's or sandbox's `errorReason`. */
const buildFailure = (error: unknown): string | null => {
  const message = messageOf(error)
  const snapshot = /^Failed to create snapshot\. Name: \S+ Reason: ([\s\S]*)$/.exec(message)
  if (snapshot) return snapshot[1] ?? ''
  const sandbox = /failed to start with status: build_failed, error reason: ([\s\S]*)$/.exec(
    message,
  )
  return sandbox ? (sandbox[1] ?? '') : null
}

/**
 * Makes sure Daytona has snapshot `name`, building it from `image` when it doesn't, and says
 * `no-permission` when the key can't make or read snapshots. A snapshot another run (or a CLI
 * that was killed) left on its way is waited on for up to `waits.waitMs`; an inactive one is
 * activated; one in `error` or `build_failed` is deleted and built once more, and a build that
 * fails is a config failure with Daytona's reason.
 */
export async function ensureSnapshot(
  api: Daytona,
  o: {
    name: string
    image: () => Promise<Image>
    resources: Resources
    signal: AbortSignal
    log: (line: string) => void
    /** The generated Dockerfile, which a build failure names. */
    dockerfileLog: string | null
    waits?: typeof SNAPSHOT_WAITS
    /** Called once, when the snapshot isn't ready to use: it's built, rebuilt or waited on. */
    building?: () => void
  },
): Promise<'ready' | 'no-permission'> {
  const waits = o.waits ?? SNAPSHOT_WAITS
  const { name, signal } = o
  const deadline = Date.now() + waits.waitMs
  const call = <T>(work: () => Promise<T>) => whileLimited('calls', work, signal)
  const unreachable = (error: unknown) =>
    failed({
      class: 'transient',
      ref: name,
      message: `Couldn't reach Daytona: ${messageOf(error)}`,
    })
  let rebuilt = false
  let reported: string | undefined
  let busy = false
  const building = () => {
    if (!busy) o.building?.()
    busy = true
  }
  for (;;) {
    signal.throwIfAborted()
    let found: Snapshot | null
    try {
      found = await call(() => api.snapshot.get(name))
    } catch (error) {
      if (signal.aborted) throw error
      const code = statusOf(error)
      if (code === 401 || code === 403) return 'no-permission'
      if (code !== 404) throw unreachable(error)
      found = null
    }
    if (!found) {
      building()
      o.log(`daytona: building snapshot ${name}`)
      const built = await build()
      if (built === 'no-permission' || built === 'ready') return built
      await wait('being created by another run')
      continue
    }
    const state = found.state ?? 'unknown'
    if (state === 'active') return 'ready'
    if (state === 'error' || state === 'build_failed') {
      const reason = found.errorReason || 'no reason given'
      if (rebuilt) throw buildFailed(reason)
      rebuilt = true
      building()
      o.log(`daytona: snapshot ${name} is in ${state} (${reason}): deleting it to build it again`)
      await call(() => api.snapshot.delete(found)).catch((error: unknown) => {
        if (signal.aborted) throw error
        if (statusOf(error) !== 404) throw unreachable(error)
      })
      continue
    }
    if (state === 'inactive') {
      o.log(`daytona: activating snapshot ${name}`)
      await call(() => api.snapshot.activate(found)).catch((error: unknown) => {
        if (signal.aborted) throw error
        if (statusOf(error) !== 409) throw unreachable(error)
      })
      continue
    }
    await wait(state)
  }

  async function wait(state: string) {
    building()
    if (Date.now() >= deadline) {
      throw failed({
        class: 'transient',
        ref: name,
        message: `Daytona's snapshot ${name} was still ${state} after ${spell(waits.waitMs)}. Another run may be building it: run again once it's active, or delete it in Daytona to build it anew.`,
      })
    }
    if (reported !== state) o.log(`daytona: waiting for snapshot ${name}, which is ${state}`)
    reported = state
    await sleep(waits.pollMs, undefined, { signal })
  }

  function buildFailed(reason: string) {
    return failed({
      class: 'config',
      ref: name,
      log: o.dockerfileLog,
      message: `Daytona couldn't build snapshot ${name}: ${reason}${o.dockerfileLog ? `\nThe Dockerfile reeval generated is ${o.dockerfileLog}` : ''}`,
    })
  }

  async function build(): Promise<'ready' | 'no-permission' | 'again'> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(waits.buildMs)])
    try {
      const creating = call(async () =>
        api.snapshot.create({ name, image: await o.image(), resources: o.resources }, {}),
      )
      await abortable(creating, timeout, () => {})
      return 'ready'
    } catch (error) {
      if (signal.aborted) throw error
      if (timeout.aborted) {
        throw failed({
          class: 'transient',
          ref: name,
          message: `Daytona's build of snapshot ${name} didn't finish in ${spell(waits.buildMs)}`,
        })
      }
      const code = statusOf(error)
      if (code === 401 || code === 403) return 'no-permission'
      // Another run asked for it first: wait on theirs.
      if (code === 409) return 'again'
      const reason = buildFailure(error)
      if (reason !== null) throw buildFailed(reason || 'no reason given')
      throw unreachable(error)
    }
  }
}

/**
 * Builds the image once in a sandbox that stops after 15 idle minutes and is deleted as it stops,
 * so the run's creates find it in Daytona's build cache, and deletes it.
 */
export async function warmImage(
  api: Daytona,
  sandbox: DaytonaSandboxDescriptor,
  o: {
    name: string
    image: () => Promise<Image>
    resources: Resources
    signal: AbortSignal
    dockerfileLog: string | null
  },
): Promise<void> {
  const name = `${sandbox.prefix}-warm-${o.name.slice(-12)}-${randomBytes(2).toString('hex')}`
  const remove = (s: Sandbox) => s.delete().catch(() => {})
  const creating = whileLimited(
    'starts',
    async () =>
      api.create(
        {
          name,
          image: await o.image(),
          resources: o.resources,
          labels: { ...sandboxLabels(), ...runLabels(sandbox, 'preflight') },
          autoStopInterval: 15,
          autoDeleteInterval: 0,
        },
        { timeout: BUILD_TIMEOUT_S },
      ),
    o.signal,
  )
  const created = await abortable(creating, o.signal, remove).catch(async (error: unknown) => {
    if (o.signal.aborted) throw error
    const id = (error as { sandboxId?: string }).sandboxId
    if (id) await api.get(id).then(remove, () => {})
    const reason = buildFailure(error)
    if (reason !== null) {
      throw failed({
        class: 'config',
        ref: o.name,
        log: o.dockerfileLog,
        message: `Daytona couldn't build the image ${o.name}: ${reason || 'no reason given'}${o.dockerfileLog ? `\nThe Dockerfile reeval generated is ${o.dockerfileLog}` : ''}`,
      })
    }
    throw failed({
      class: 'transient',
      ref: o.name,
      message: `Daytona didn't start a sandbox to build the image ${o.name}: ${messageOf(error)}`,
    })
  })
  await remove(created)
}

/**
 * Preflight for a recipe's sandbox: checks the organization, generates the image and has Daytona
 * build it, into a snapshot or, when the key can't make snapshots, once into its build cache for
 * every create to find. Null without a recipe: sandboxes start from Daytona's default snapshot.
 */
export async function prepareDaytona(
  sandbox: DaytonaSandboxDescriptor,
  harness: HarnessDescriptor,
  ctx: PrepareContext,
  waits?: typeof SNAPSHOT_WAITS,
): Promise<PreparedHandle> {
  await checkDaytona(sandbox, ctx.root)
  const image = await ctx.retry(() => daytonaImage(sandbox, harness, { signal: ctx.signal }))
  if (!image) return null
  if (image.unpinned) {
    ctx.log(
      `daytona: ${image.unpinned.ref} isn't pinned by digest (${image.unpinned.reason}), so the image is keyed on its name`,
    )
  }
  const dockerfileLog = join(ctx.root, '.reeval', 'cache', 'images', `${image.name}.Dockerfile`)
  await mkdir(dirname(dockerfileLog), { recursive: true })
  await writeFile(dockerfileLog, image.dockerfile)
  const api = await daytonaClient(sandbox, ctx.root)
  const built = () => sdkImage(image, ctx.root)
  const resources = resourcesOf(sandbox.size ?? 'medium')
  const common = { name: image.name, image: built, resources, signal: ctx.signal, dockerfileLog }
  let building = false
  const got = await ensureSnapshot(api, {
    ...common,
    log: ctx.log,
    ...(waits && { waits }),
    building: () => {
      building = true
      ctx.image?.({ name: image.name, cached: false })
    },
  })
  if (!building) ctx.image?.({ name: image.name, cached: got === 'ready' })
  const start: DaytonaStart = {
    name: image.name,
    harnessBaked: image.harnessBaked,
    ...(got === 'ready'
      ? { snapshot: image.name }
      : {
          dockerfile: image.dockerfile,
          ...(image.contextDir !== undefined && { contextDir: image.contextDir }),
        }),
  }
  if (got === 'no-permission') {
    ctx.log(
      `daytona: the key in ${sandbox.apiKey.from} can't make snapshots, so every sandbox builds ${image.name}; building it once so Daytona's build cache has it`,
    )
    await warmImage(api, sandbox, common)
  }
  return { start, baked: image.name, key: image.key }
}

/** What a sandbox starts from, as {@link prepareDaytona} left it. */
export const daytonaStart = (handle: PreparedHandle): DaytonaStart | undefined => {
  const start = (handle as { start?: unknown } | null)?.start
  return start && typeof start === 'object' ? (start as DaytonaStart) : undefined
}

/** How long a created sandbox may take to start, in seconds. */
const START_TIMEOUT_S = 180
/** How long a sandbox whose image Daytona builds (or finds in its build cache) may take, in seconds. */
const BUILD_TIMEOUT_S = 30 * 60
/** How long a run's cleanup may wait on one organization, so an unreachable API can't stall it. */
const CLEANUP_TIMEOUT_MS = 30_000
/**
 * How long an SSH token lives: past any attempt's machine, which the pool keeps alive and reuses,
 * and which deleting the sandbox revokes first.
 */
const SSH_TOKEN_MINUTES = 24 * 60

/**
 * Where `ssh` reaches the sandbox from Daytona's `sshCommand` (`ssh <token>@ssh.app.daytona.io`,
 * maybe with `-p <port>`), or null when it names no host.
 */
export function sshTarget(command: string): { user: string; host: string; port: number } | null {
  const words = command.trim().split(/\s+/)
  if (words[0] !== 'ssh') return null
  let port = 22
  let destination: string | undefined
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string
    if (word === '-p') port = Number(words[++i])
    else if (word.startsWith('-p') && /^-p\d+$/.test(word)) port = Number(word.slice(2))
    else if (word === '-o' || word === '-i' || word === '-l') i++
    else if (!word.startsWith('-')) destination ??= word
  }
  const at = destination?.lastIndexOf('@') ?? -1
  if (!destination || at <= 0 || !Number.isInteger(port) || port <= 0) return null
  return { user: destination.slice(0, at), host: destination.slice(at + 1), port }
}

/** The SSH server's host keys at `host:port`, as known_hosts lines under `alias`. */
async function hostKeys(host: string, port: number, alias: string): Promise<string> {
  const scanned = await run('ssh-keyscan', ['-T', '10', '-p', String(port), host])
  const lines = scanned.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .filter((w) => w.length >= 3)
    .map((w) => `${alias} ${w[1]} ${w[2]}`)
  if (!lines.length) {
    throw new InfraError(
      `Daytona's SSH gateway at ${host}:${port} gave no host key: ${scanned.stderr.trim().slice(-300) || 'ssh-keyscan found none'}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * The organization's pool. Daytona says no start limits up front, so the pool starts what the run
 * asks for, up to `maxConcurrent`, and holds every start back for a 429's `Retry-After`.
 */
export const openDaytonaPool: OpenPool<DaytonaSandboxDescriptor> = async (sandbox, o) => {
  const api = await daytonaClient(sandbox, o.root)
  const k = sandbox.attemptsPerMachine ?? 1
  const start = o.image as DaytonaStart | undefined
  const image = start?.dockerfile ? await sdkImage(start, o.root) : undefined
  return {
    provider: daytonaPoolProvider(sandbox, api, o.runId, start && { ...start, image }),
    options: {
      limits: {
        machines: sandbox.maxConcurrent ? Math.ceil(sandbox.maxConcurrent / k) : 1_000,
        startsPerMinute: null,
        startsPerHour: null,
      },
      attemptsPerMachine: k,
      reuse: sandbox.reuse ?? false,
    },
  }
}

/** Starting, keeping and removing `descriptor`'s sandboxes for the run's pool, in the main process. */
export function daytonaPoolProvider(
  descriptor: DaytonaSandboxDescriptor,
  api: Daytona,
  runId: string,
  start?: DaytonaStart & { image?: Image },
): PoolProvider<PooledSshMachine> {
  const size = descriptor.size ?? 'medium'
  const snapshot = start ? start.snapshot : snapshotOf(descriptor)
  // A built image starts as root, with no sudo: reeval's own commands run as it.
  const loginRoot = start !== undefined
  const labels = runLabels(descriptor, runId)
  const extra = sandboxLabels()
  const made = new Map<string, { sandbox: Sandbox; dir: string }>()
  const remove = async (sandbox: Sandbox) => {
    await sandbox.delete().catch((error: unknown) => {
      if (statusOf(error) !== 404) throw error
    })
  }
  return {
    helper: 'daytona()',
    rateLimited: (error): RateLimited | null =>
      error instanceof DaytonaRateLimited ? { retryAfterMs: error.retryAfterMs } : null,
    async keepAlive(id, ttlSeconds) {
      const sandbox = made.get(id)?.sandbox ?? (await whileLimited('calls', () => api.get(id)))
      await whileLimited('calls', () => sandbox.setTtl(Math.ceil(ttlSeconds / 60)))
    },
    async remove(id) {
      const entry = made.get(id)
      made.delete(id)
      await remove(entry?.sandbox ?? (await api.get(id).catch(() => null)) ?? never(id)).catch(
        () => {},
      )
      if (entry) await rm(entry.dir, { recursive: true, force: true })
    },
    async start(signal, ttlSeconds) {
      const name = `${descriptor.prefix}-${labels['reeval-run']}-${randomBytes(3).toString('hex')}`
      const dir = await mkdtemp(join(tmpdir(), 'reeval-daytona-'))
      let sandbox: Sandbox | undefined
      try {
        const creating = api.create(
          {
            name,
            ...(snapshot ? { snapshot } : { image: start?.image, resources: resourcesOf(size) }),
            labels: { ...extra, ...labels },
            // The pool says when a machine goes; Daytona's idle stop would cut an attempt off.
            autoStopInterval: 0,
            ephemeral: true,
            ttlMinutes: Math.ceil(ttlSeconds / 60),
          },
          { timeout: snapshot ? START_TIMEOUT_S : BUILD_TIMEOUT_S },
        )
        // The SDK's create takes no signal: a cancel stops the wait, and a sandbox it makes after
        // that is deleted.
        const created: Sandbox = await abortable(creating, signal, (late) =>
          remove(late).catch(() => {}),
        ).catch(async (error: unknown) => {
          if (signal.aborted) throw error
          const limited = rateLimited(error, 'starts')
          if (limited) throw limited
          // A start that timed out may still come up: find it by its id to delete it.
          const id = (error as { sandboxId?: string }).sandboxId
          if (id) await api.get(id).then(remove, () => {})
          throw new InfraError(`Daytona didn't start a sandbox: ${messageOf(error)}`)
        })
        sandbox = created
        const access = await whileLimited(
          'calls',
          () => created.createSshAccess(SSH_TOKEN_MINUTES),
          signal,
        ).catch((error: unknown) => {
          if (signal.aborted) throw error
          throw new InfraError(`Daytona didn't give SSH access: ${messageOf(error)}`)
        })
        registerSecret(access.token)
        const target = sshTarget(access.sshCommand)
        if (!target) {
          throw new InfraError(
            `Daytona gave sandbox ${sandbox.id} no SSH destination to connect to (got ${JSON.stringify(redactSecrets(access.sshCommand))})`,
          )
        }
        const key = await newKey(dir, 'Daytona')
        const knownHostsFile = join(dir, 'known_hosts')
        await writeFile(knownHostsFile, await hostKeys(target.host, target.port, sandbox.id))
        signal.throwIfAborted()
        made.set(sandbox.id, { sandbox, dir })
        return {
          id: sandbox.id,
          info: {
            id: sandbox.id,
            name,
            size,
            host: target.host,
            port: target.port,
            user: target.user,
            identityFile: key.file,
            knownHostsFile,
            route: `${target.host}:${target.port} (Daytona's SSH gateway)`,
            secretUser: true,
            ...(loginRoot && { loginRoot: true }),
            ...(start?.harnessBaked && { harnessBaked: true }),
          },
        }
      } catch (error) {
        if (sandbox) await remove(sandbox).catch(() => {})
        await rm(dir, { recursive: true, force: true })
        throw error
      }
    },
  }
}

const never = (id: string): never => {
  throw new Error(`no Daytona sandbox ${id}`)
}

export async function createDaytonaSandbox(
  descriptor: DaytonaSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  let start: DaytonaStart | undefined
  if (options.harness) {
    const { preparedFor } = await import('./preflight.ts')
    const { daytonaProvider } = await import('./providers.ts')
    const handle = preparedFor(
      process.cwd(),
      options.runId,
      daytonaProvider(),
      descriptor,
      options.harness,
    )
    start = handle ? daytonaStart(handle) : undefined
  }
  const { image, from, dockerfile, install } = descriptor
  if (!start && (image ?? from ?? dockerfile ?? install) !== undefined) {
    throw new InfraError("The daytona() sandbox's image wasn't prepared before the run started")
  }
  return createPooledSshSandbox(descriptor, options, {
    ...(start && { image: start }),
    helper: 'daytona()',
    sandbox: 'daytona',
    size: descriptor.size ?? 'medium',
    description: (info) => `daytona sandbox ${info.id} (${info.size})`,
  })
}

/**
 * Deletes every sandbox the run left on each organization and prefix in `sandboxes`, found by the
 * run's labels: another prefix, or another run's tag, is someone else's.
 */
export async function removeRunSandboxes(
  runId: string,
  sandboxes: readonly DaytonaSandboxDescriptor[],
): Promise<void> {
  const seen = new Set<string>()
  for (const sandbox of sandboxes) {
    const key = `${sandbox.apiKey.from}\0${sandbox.prefix}`
    if (seen.has(key) || daytonaKeyProblem(sandbox)) continue
    seen.add(key)
    const api = await daytonaClient(sandbox).catch(() => null)
    if (!api) continue
    const deadline = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    const work = (async () => {
      const left: Sandbox[] = []
      for await (const s of api.list({ labels: runLabels(sandbox, runId), limit: 100 })) {
        left.push(s)
      }
      await Promise.all(left.map((s) => s.delete().catch(() => {})))
    })().catch(() => {})
    await Promise.race([
      work,
      new Promise<void>((resolve) => deadline.addEventListener('abort', () => resolve())),
    ])
  }
}

/** The machines and attempts the run's pool keeps going: `maxConcurrent`'s, when it's set. */
export async function daytonaCapacity(
  sandbox: DaytonaSandboxDescriptor,
): Promise<{ machines: number; attempts: number } | null> {
  if (!sandbox.maxConcurrent) return null
  const k = sandbox.attemptsPerMachine ?? 1
  return { machines: Math.ceil(sandbox.maxConcurrent / k), attempts: sandbox.maxConcurrent }
}

/** The host's OpenSSH tools a Daytona sandbox runs on, or the first one missing. */
export const missingDaytonaSshTool = () =>
  missingSshTool([
    ['ssh', ['-V']],
    ['ssh-keygen', ['-?']],
    ['ssh-keyscan', ['-?']],
  ])

/**
 * Preflight's check of one organization: the host has OpenSSH, the key is set, the SDK loads, and
 * Daytona takes the key (listing the run's sandboxes, which it refuses for a bad one).
 */
export async function checkDaytona(sandbox: DaytonaSandboxDescriptor, projectRoot: string) {
  try {
    sandboxLabels()
  } catch (error) {
    throw usage((error as Error).message)
  }
  const tool = await missingDaytonaSshTool()
  if (tool) {
    throw usage(
      `daytona() runs every command over SSH, and there's no ${tool} on PATH: install an OpenSSH client (openssh-client on Debian and Ubuntu)`,
    )
  }
  const api = await daytonaClient(sandbox, projectRoot)
  try {
    for await (const _ of api.list({ labels: runLabels(sandbox, 'preflight'), limit: 1 })) break
  } catch (error) {
    const code = statusOf(error)
    if (code === 401 || code === 403) {
      throw usage(`Daytona refused the API key in ${sandbox.apiKey.from}: ${messageOf(error)}`)
    }
    throw new PrepareError({
      class: 'transient',
      stage: 'daytona',
      ref: null,
      cause: null,
      log: null,
      message: `Couldn't reach Daytona: ${messageOf(error)}`,
    })
  }
}

/** `reeval doctor`: the OpenSSH client, and each Daytona organization `sandboxes` use. */
export async function daytonaDoctor(
  sandboxes: readonly DaytonaSandboxDescriptor[],
  ctx: DoctorContext,
): Promise<Check[]> {
  const accounts = new Map<string, DaytonaSandboxDescriptor>()
  for (const sandbox of sandboxes) accounts.set(sandbox.apiKey.from, sandbox)
  if (!accounts.size) return []
  const missing = await ctx.deps.missingSshTool()
  const checks: Check[] = [
    missing
      ? {
          id: 'ssh',
          status: 'fail',
          summary: `daytona() runs every command over SSH, and there's no ${missing} on PATH`,
          fix: 'install an OpenSSH client (openssh-client on Debian and Ubuntu)',
        }
      : { id: 'ssh', status: 'ok', summary: 'an OpenSSH client for daytona()' },
  ]
  for (const sandbox of accounts.values()) {
    const key = sandbox.apiKey.from
    if (!ctx.deps.env[key]) {
      checks.push({
        id: 'daytona',
        status: 'fail',
        summary: `daytona() needs a Daytona API key in ${key}, which isn't set`,
        fix: `set ${key} in ${ctx.envFile}`,
      })
      continue
    }
    try {
      await ctx.deps.daytonaAccount(sandbox, ctx.root, ctx.online)
      checks.push({
        id: 'daytona',
        status: 'ok',
        summary: ctx.online
          ? `Daytona takes the key in ${key}`
          : `Daytona's SDK loads, and ${key} is set (--online asks Daytona whether it takes the key)`,
      })
    } catch (error) {
      checks.push({
        id: 'daytona',
        status: 'fail',
        summary: redactSecrets((error as Error).message),
      })
    }
  }
  return checks
}
