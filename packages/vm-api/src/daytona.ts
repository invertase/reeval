// Daytona through its SDK, `@daytona/sdk`. The caller builds the SDK's `Daytona` client, so this
// module only imports its types and never loads the SDK itself. A sandbox logs in over Daytona's
// SSH gateway with a token as the user.
import type { Daytona, Sandbox } from '@daytona/sdk'
import { retryAtOf, VmApiError } from './errors.ts'
import { kindOfStatus, networkError, shapeError } from './http.ts'
import type { CreateVm, SshAccess, VmApi, VmCapabilities, VmInfo, VmState } from './types.ts'

export const DAYTONA_CAPABILITIES: VmCapabilities = {
  envAtCreate: true,
  processes: false,
  maxExecSeconds: null,
  ttl: 'minutes',
  labelFilter: true,
  namePrefixFilter: false,
  idempotentCreate: false,
  sshHostKey: false,
  limits: false,
  images: 'build-dockerfile',
  sizes: ['small', 'medium', 'large'],
}

/** Daytona's states a sandbox never leaves for `started`. */
export const DAYTONA_DEAD_STATES: readonly string[] = [
  'error',
  'build_failed',
  'destroyed',
  'destroying',
  'stopped',
  'stopping',
  'archived',
  'archiving',
  'pausing',
  'paused',
]

/** The default snapshot of each size. */
export const daytonaSnapshotOf = (size: string) => `daytona-${size}`

export interface DaytonaVmApi extends VmApi {
  provider: 'daytona'
}

const stateOf = (raw: string): VmState =>
  raw === 'started' ? 'ready' : DAYTONA_DEAD_STATES.includes(raw) ? 'dead' : 'starting'

const info = (s: Sandbox): VmInfo => {
  const raw = s.state ?? 'unknown'
  return {
    id: s.id,
    name: s.name,
    state: stateOf(raw),
    raw,
    ...(s.errorReason && { error: s.errorReason }),
    labels: s.labels ?? {},
  }
}

/**
 * Where `ssh` reaches the sandbox from Daytona's `sshCommand` (`ssh <token>@ssh.app.daytona.io`,
 * maybe with `-p <port>`), or null when it names no host.
 */
export function daytonaSshTarget(
  command: string,
): { user: string; host: string; port: number } | null {
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

/** The SDK's `DaytonaError`, the fields read here. */
type SdkError = Error & {
  statusCode?: number
  code?: string
  headers?: { get?(name: string): unknown }
}

/** The SDK's errors, by the fields every `DaytonaError` has, so a bundle that renames classes matches too. */
const isSdkError = (error: unknown): error is SdkError =>
  error instanceof Error && 'statusCode' in error && 'source' in error

/** An SDK failure as a {@link VmApiError}; anything that isn't one is thrown as it is. */
function failure(label: string, error: unknown): unknown {
  if (!isSdkError(error)) return error
  const e = error
  if (typeof e.statusCode !== 'number' || e.statusCode === 0) {
    // Only a refused or dropped connection got no answer; a check the SDK made itself, or its own
    // wait running out, isn't one a resend fixes.
    if (e.name.includes('Connection')) return networkError('daytona', label, e.message)
    return new VmApiError({
      provider: 'daytona',
      label,
      status: 0,
      code: e.code ?? 'sdk_error',
      kind: 'unknown',
      retryable: false,
      detail: e.message,
    })
  }
  const status = e.statusCode
  const { kind, retryable } = kindOfStatus(status)
  const said = e.headers?.get?.('retry-after')
  const retryAt =
    kind === 'rate-limited' || kind === 'capacity'
      ? retryAtOf(undefined, typeof said === 'string' ? said : null, e.message)
      : undefined
  return new VmApiError({
    provider: 'daytona',
    label,
    status,
    code: e.code ?? `http_${status}`,
    kind,
    retryable,
    ...(retryAt !== undefined && { retryAt }),
    detail: `${status} ${e.message}`,
  })
}

async function call<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw failure(label, error)
  }
}

const isNotFound = (error: unknown) => error instanceof VmApiError && error.status === 404

/** Settles with `work`, or rejects with `signal`'s reason; what `work` makes after that goes to `late`. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined, late: (v: T) => void) {
  if (!signal) return work
  if (signal.aborted) {
    work.then(late, () => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      work.then(late, () => {})
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', abort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(e)
      },
    )
  })
}

/**
 * Daytona's API through `client`, the SDK's `Daytona`. Its create waits until the sandbox has
 * started (or `startTimeoutSeconds` passes), so a created machine is already `ready`.
 */
export function daytonaApi(
  client: Daytona,
  o: { startTimeoutSeconds?: number } = {},
): DaytonaVmApi {
  const sandboxes = new Map<string, Sandbox>()
  const sandbox = async (label: string, id: string) =>
    sandboxes.get(id) ?? (await call(label, () => client.get(id)))

  return {
    provider: 'daytona',
    capabilities: DAYTONA_CAPABILITIES,

    async create(r: CreateVm, opts = {}) {
      const creating = call('create', () =>
        client
          .create(
            {
              name: r.name,
              snapshot: r.from ?? daytonaSnapshotOf(r.size),
              labels: r.labels,
              envVars: r.env ?? {},
              // The caller says when a machine goes; Daytona's idle stop would cut its work off.
              autoStopInterval: 0,
              // Deleted as soon as it stops, so nothing is left to archive.
              autoDeleteInterval: 0,
              ttlMinutes: Math.ceil(r.ttlSeconds / 60),
            },
            { timeout: o.startTimeoutSeconds ?? 120 },
          )
          .catch(async (error: unknown) => {
            // A create whose wait ran out names the sandbox it made and leaves it running.
            const made = (error as { sandboxId?: unknown }).sandboxId
            if (typeof made === 'string') {
              await client
                .get(made)
                .then((s) => s.delete())
                .catch(() => {})
            }
            throw error
          }),
      )
      // The SDK's create takes no signal: a cancel stops the wait, and a sandbox made after it is deleted.
      const made = await abortable(creating, opts.signal, (late) => {
        late.delete().catch(() => {})
      })
      sandboxes.set(made.id, made)
      return info(made)
    },

    async get(id) {
      try {
        const got = await call(`get ${id}`, () => client.get(id))
        sandboxes.set(id, got)
        return info(got)
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async sshAccess(id, r): Promise<SshAccess> {
      const label = `ssh-access ${id}`
      const s = await sandbox(label, id)
      const access = await call(label, () => s.createSshAccess(r.minutes))
      const target = daytonaSshTarget(access.sshCommand)
      if (!target) throw shapeError('daytona', label, 'gave no SSH destination to connect to')
      return {
        user: target.user,
        routes: [{ host: target.host, port: target.port, via: "Daytona's SSH gateway" }],
        auth: 'token',
      }
    },

    async setTtl(id, seconds) {
      const label = `ttl ${id}`
      const s = await sandbox(label, id)
      await call(label, () => s.setTtl(Math.ceil(seconds / 60)))
      return {}
    },

    async remove(id) {
      const label = `delete ${id}`
      try {
        const s = await sandbox(label, id)
        await call(label, () => s.delete())
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      sandboxes.delete(id)
    },

    async *list(filter) {
      const found = call('list', async () => {
        const all: Sandbox[] = []
        for await (const s of client.list({
          ...(filter.labels && { labels: filter.labels }),
          limit: 100,
        })) {
          all.push(s)
        }
        return all
      })
      for (const s of await found) {
        if (!filter.namePrefix || s.name.startsWith(filter.namePrefix)) yield info(s)
      }
    },
  }
}
