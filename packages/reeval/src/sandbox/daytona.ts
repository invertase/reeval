// Daytona sandboxes: Daytona's SDK (an optional peer, imported only here) creates and deletes
// them in the run's main process, and every process runs over Daytona's SSH gateway with a token
// per machine, the egress gateway's forwarder included, so credentials stay on the host as they do
// for Docker.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { run } from '@reeval/sandbox-docker/process'
import type { Check } from '../doctor.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import type { DaytonaSandboxDescriptor } from '../types.ts'
import { retryAfterMs, runTag } from './boat.ts'
import type { SandboxOptions } from './index.ts'
import type { DoctorContext } from './kinds.ts'
import type { OpenPool } from './machine-service.ts'
import { optionalPeer } from './optional-peer.ts'
import { type PoolProvider, RATE_LIMIT_WAITS, type RateLimited } from './pool.ts'
import { PrepareError } from './provider.ts'
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

/** What reeval reads of a sandbox, typed here so no SDK type reaches reeval's own. */
export type DaytonaSandboxInfo = {
  id: string
  name: string
  state?: string
  createSshAccess(expiresInMinutes?: number): Promise<{ token: string; sshCommand: string }>
  setTtl(ttlMinutes: number): Promise<void>
  delete(timeout?: number): Promise<void>
}

/** The SDK calls reeval makes. */
export type DaytonaClient = {
  create(
    params: {
      name: string
      snapshot: string
      labels: Record<string, string>
      autoStopInterval: number
      ephemeral: boolean
      ttlMinutes: number
    },
    options: { timeout: number },
  ): Promise<DaytonaSandboxInfo>
  get(idOrName: string): Promise<DaytonaSandboxInfo>
  list(query: { labels: Record<string, string>; limit?: number }): AsyncIterable<DaytonaSandboxInfo>
}

type DaytonaSdk = {
  Daytona: new (config: {
    apiKey?: string
    apiUrl?: string
    useDeprecatedPolling?: boolean
  }) => DaytonaClient
}

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
  const value = process.env[name]
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
): Promise<DaytonaClient> {
  const problem = daytonaKeyProblem(sandbox)
  if (problem) throw usage(`${problem}. Set it in the environment or the project's .env.local.`)
  const { Daytona } = await loadDaytonaSdk(projectRoot)
  const apiKey = process.env[sandbox.apiKey.from]
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

/** The labels every sandbox of the run carries, which its cleanup lists by. */
export const runLabels = (sandbox: Pick<DaytonaSandboxDescriptor, 'prefix'>, runId: string) => ({
  'reeval-prefix': sandbox.prefix,
  'reeval-run': runTag(runId),
})

/** How long a created sandbox may take to start, in seconds. */
const START_TIMEOUT_S = 180
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
  return {
    provider: daytonaPoolProvider(sandbox, api, o.runId),
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
  api: DaytonaClient,
  runId: string,
): PoolProvider<PooledSshMachine> {
  const size = descriptor.size ?? 'medium'
  const snapshot = snapshotOf(descriptor)
  const labels = runLabels(descriptor, runId)
  const made = new Map<string, { sandbox: DaytonaSandboxInfo; dir: string }>()
  const remove = async (sandbox: DaytonaSandboxInfo) => {
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
      let sandbox: DaytonaSandboxInfo | undefined
      try {
        const creating = api.create(
          {
            name,
            snapshot,
            labels,
            // The pool says when a machine goes; Daytona's idle stop would cut an attempt off.
            autoStopInterval: 0,
            ephemeral: true,
            ttlMinutes: Math.ceil(ttlSeconds / 60),
          },
          { timeout: START_TIMEOUT_S },
        )
        // The SDK's create takes no signal: a cancel stops the wait, and a sandbox it makes after
        // that is deleted.
        const created: DaytonaSandboxInfo = await abortable(creating, signal, (late) =>
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

export function createDaytonaSandbox(
  descriptor: DaytonaSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  return createPooledSshSandbox(descriptor, options, {
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
      const left: DaytonaSandboxInfo[] = []
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
