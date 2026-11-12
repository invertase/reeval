// boat.dev's API (https://docs.boat.dev/api/v1) through its SDK, `@boatdev/sdk`. The caller builds
// the SDK's `BoatApi`, so this module only imports its types and never loads the SDK itself. Where
// `node:http2` isn't available, give the SDK's `Configuration` a `fetchApi`: its own default on a
// Node-compatible runtime is HTTP/2 through it.
import type {
  BoatApi,
  CreateSandboxRequestTypeEnum,
  Sandbox,
  SavedSnapshot,
  SshKeyResponse,
} from '@boatdev/sdk'
import {
  DEFAULT_TIMEOUT_MS,
  type Failures,
  kindOfStatus,
  networkError,
  orNull,
  responseError,
  shapeError,
} from './http.ts'
import type {
  CreateVm,
  ExecResult,
  ProcessStatus,
  SshAccess,
  SshRoute,
  VmApi,
  VmCapabilities,
  VmInfo,
  VmLimits,
  VmState,
} from './types.ts'

/** Boat's states a sandbox never leaves for `ready`; a canceled one answers 404 once it's reported. */
export const BOAT_DEAD_STATES: readonly string[] = ['archived', 'archiving', 'error', 'cancelled']
const READY_STATES: readonly string[] = ['ready', 'idle', 'running']

/** A sync command's `timeoutSeconds` ceiling; Boat answers `400 invalid_timeout` past it. */
export const BOAT_MAX_EXEC_SECONDS = 600
/** What a sync command may take on top of its own timeout before its request is abandoned. */
const EXEC_GRACE_MS = 15_000
/**
 * How long a create may take: one abandoned mid-way may still make a machine whose id is never
 * known, so it waits well past an ordinary call.
 */
const CREATE_TIMEOUT_MS = 180_000

export const BOAT_CAPABILITIES: VmCapabilities = {
  envAtCreate: true,
  processes: true,
  maxExecSeconds: BOAT_MAX_EXEC_SECONDS,
  ttl: 'seconds',
  labelFilter: true,
  namePrefixFilter: true,
  idempotentCreate: true,
  sshHostKey: true,
  limits: true,
  images: 'save-vm',
  sizes: ['small', 'default', 'large', 'xlarge'],
}

/** A saved snapshot: a VM's disk, which later sandboxes start `from`. */
export type BoatSavedSnapshot = SavedSnapshot

export interface BoatVmApi extends VmApi {
  provider: 'boat'
  limits(o?: { signal?: AbortSignal }): Promise<VmLimits>
  exec(
    id: string,
    command: string,
    o?: { timeoutSeconds?: number; cwd?: string },
  ): Promise<ExecResult>
  spawn(id: string, command: string, o?: { cwd?: string }): Promise<{ processId: string }>
  status(id: string, processId: string, o?: { tailBytes?: number }): Promise<ProcessStatus>
  savedSnapshots: {
    /** The snapshot, or null when there's none of that name. */
    get(name: string): Promise<BoatSavedSnapshot | null>
    /** Saves `sandboxId` as `name`; it reports `saving` until it's `ready` or `failed`. */
    save(sandboxId: string, name: string): Promise<BoatSavedSnapshot>
    /** Deletes it; one already gone counts as deleted. */
    remove(name: string): Promise<void>
    list(): Promise<BoatSavedSnapshot[]>
  }
}

const stateOf = (raw: string): VmState =>
  READY_STATES.includes(raw) ? 'ready' : BOAT_DEAD_STATES.includes(raw) ? 'dead' : 'starting'

const info = (s: Sandbox, ttlSeconds?: number | null): VmInfo => {
  const error = s.error ?? s.setupError
  const ttl = ttlSeconds ?? s.ttlSeconds
  return {
    id: s.id,
    name: s.name,
    state: stateOf(s.state),
    raw: s.state,
    ...(error && { error }),
    labels: s.labels ?? {},
    ...(typeof ttl === 'number' && { ttlSeconds: ttl }),
  }
}

/**
 * Where a sandbox's sshd answers, best first: the VM's own address on port 22, then the public
 * endpoint Boat forwards. The address is IPv6, which a host without IPv6 can't reach; the endpoint
 * is NAT'd, which another VM on the same Boat host can't reach.
 */
export function boatSshRoutes(
  reply: Pick<SshKeyResponse, 'machineIp' | 'sshEndpoint'>,
): SshRoute[] {
  const routes: SshRoute[] = []
  if (reply.machineIp) routes.push({ host: reply.machineIp, port: 22, via: 'machine address' })
  const endpoint = /^(.+):(\d+)$/.exec(reply.sshEndpoint ?? '')
  if (endpoint) {
    const host = (endpoint[1] as string).replace(/^\[(.*)\]$/, '$1')
    routes.push({ host, port: Number(endpoint[2]), via: 'public endpoint' })
  }
  return routes
}

type ErrorBody = {
  code?: string
  message?: string
  retryable?: boolean
  error?: string | { code?: string; message?: string; retryable?: boolean }
}

const failures: Failures = {
  provider: 'boat',
  describe(status, body, text) {
    const b = (body ?? {}) as ErrorBody
    const nested = typeof b.error === 'object' ? b.error : undefined
    const code =
      b.code ?? nested?.code ?? (typeof b.error === 'string' ? b.error : `http_${status}`)
    if (typeof b.error === 'string') return { code, message: b.error }
    const words = b.message ?? nested?.message
    const message =
      body && (b.code ?? nested?.code ?? words)
        ? [b.code ?? nested?.code, words].filter(Boolean).join(': ')
        : text.slice(0, 300)
    return { code, message }
  },
  classify(status, code, body, label) {
    const b = body as ErrorBody | undefined
    const said = b?.retryable ?? (typeof b?.error === 'object' ? b.error.retryable : undefined)
    // Boat answers 403 for another account's sandbox too; only a refused start is the account's quota.
    const base =
      status === 403 && label === 'create'
        ? { kind: 'quota' as const, retryable: false }
        : code === 'rate_limited'
          ? { kind: 'rate-limited' as const, retryable: true }
          : code === 'out_of_capacity'
            ? { kind: 'capacity' as const, retryable: true }
            : kindOfStatus(status)
    // A 502 `boat_direct_failed` means the command may already be running: a resend could run it twice.
    const retryable =
      typeof said === 'boolean' ? said : code === 'boat_direct_failed' ? false : base.retryable
    return { kind: base.kind, retryable }
  },
}

/** The SDK's `ResponseError` and `FetchError`, by name, so a second copy of the SDK matches too. */
const failedResponse = (error: unknown) =>
  error instanceof Error && error.name === 'ResponseError' && 'response' in error
    ? (error.response as Response)
    : undefined
const fetchFailure = (error: unknown) =>
  error instanceof Error && error.name === 'FetchError' ? error.cause : undefined

/** Boat's API through `sdk`, the SDK's `BoatApi`; a call that takes longer than `timeoutMs` fails. */
export function boatApi(sdk: BoatApi, o: { timeoutMs?: number } = {}): BoatVmApi {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** One SDK call under a deadline, failing with a {@link VmApiError}; an aborted `signal` throws its reason. */
  async function call<T>(
    label: string,
    run: (init: RequestInit) => Promise<T>,
    o: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
  ): Promise<T> {
    const ms = o.timeoutMs ?? timeoutMs
    const timeout = AbortSignal.timeout(ms)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    try {
      return await run({ signal })
    } catch (error) {
      const response = failedResponse(error)
      if (response) {
        const text = await response.text().catch(() => '')
        throw responseError(
          failures,
          label,
          response.status,
          text,
          response.headers.get('retry-after'),
        )
      }
      if (o.signal?.aborted) throw o.signal.reason
      const cause = fetchFailure(error)
      if (cause === undefined && !timeout.aborted) throw error
      throw networkError(
        'boat',
        label,
        timeout.aborted
          ? `no answer in ${ms / 1000}s`
          : cause instanceof Error
            ? ((cause.cause as Error | undefined)?.message ?? cause.message)
            : String(cause),
      )
    }
  }

  return {
    provider: 'boat',
    capabilities: BOAT_CAPABILITIES,

    async create(r: CreateVm, o = {}) {
      const made = await call(
        'create',
        (init) =>
          sdk.create(
            {
              ...(r.idempotencyKey !== undefined && { idempotencyKey: r.idempotencyKey }),
              createSandboxRequest: {
                type: r.size as CreateSandboxRequestTypeEnum,
                name: r.name,
                ttlSeconds: r.ttlSeconds,
                labels: r.labels,
                ...(r.env && { env: r.env }),
                // Command text and environment stay out of Boat's logs.
                noEnv: true,
                snapshots: r.saveable ?? false,
                monitoring: false,
                ...(r.from !== undefined && { from: r.from }),
              },
            },
            init,
          ),
        { signal: o.signal, timeoutMs: CREATE_TIMEOUT_MS },
      )
      return info(made.sandbox, made.ttlSeconds)
    },

    async get(id, o = {}) {
      const got = await orNull(call(`get ${id}`, (init) => sdk.get({ sandboxId: id }, init), o))
      return got && info(got.sandbox)
    },

    async sshAccess(id, r): Promise<SshAccess> {
      const reply = await call(`sshkey ${id}`, (init) =>
        sdk.sshKey({ sandboxId: id, sshKeyRequest: { key: r.publicKey } }, init),
      )
      return {
        user: reply.sshUser ?? 'user',
        routes: boatSshRoutes(reply),
        ...(reply.hostKey && { hostKey: reply.hostKey.trim() }),
        auth: 'key',
      }
    },

    async setTtl(id, seconds) {
      const updated = await call(`update ${id}`, (init) =>
        sdk.update({ sandboxId: id, updateSandboxRequest: { ttlSeconds: seconds } }, init),
      )
      const ttl = updated?.sandbox?.ttlSeconds
      return typeof ttl === 'number' ? { ttlSeconds: ttl } : {}
    },

    async remove(id, o = {}) {
      await orNull(
        call(
          `delete ${id}`,
          (init) => sdk.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }, init),
          o,
        ),
      )
    },

    async *list(filter, o = {}) {
      const label = Object.entries(filter.labels ?? {}).map(([k, v]) => `${k}=${v}`)
      let cursor: string | undefined
      do {
        const page = await call(
          'list',
          (init) =>
            sdk.sandboxes(
              {
                ...(filter.namePrefix && { namePrefix: filter.namePrefix }),
                // An empty `label=` is refused as `invalid_filter`.
                ...(label.length && { label }),
                limit: 100,
                ...(cursor && { cursor }),
              },
              init,
            ),
          o,
        )
        for (const s of page.sandboxes) {
          if (!filter.namePrefix || s.name.startsWith(filter.namePrefix)) yield info(s)
        }
        cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined
      } while (cursor)
    },

    async limits(o = {}) {
      // The raw body too: the SDK's model drops the fields it doesn't know, such as `layout`.
      const { l, layout } = await call(
        'limits',
        async (init) => {
          const got = await sdk.limitsRaw({}, init)
          const body = (await got.raw.clone().json()) as { layout?: unknown } | null
          return { l: await got.value(), layout: body?.layout }
        },
        o,
      )
      const caps = l.startLimitsWithWallet ?? l.startLimits
      return {
        canStart: l.canStart,
        ...(l.startBlockedReason && { blockedReason: l.startBlockedReason }),
        live: l.activeSandboxes,
        maxLive: l.maxActiveSandboxes,
        ...(caps?.perMinute !== undefined && { startsPerMinute: caps.perMinute }),
        ...(caps?.perHour !== undefined && { startsPerHour: caps.perHour }),
        ...(l.starts?.hour?.used !== undefined && { startsThisHour: l.starts.hour.used }),
        ...(l.machineTypes && {
          sizes: l.machineTypes.map((m) => ({
            size: m.type,
            available: m.available,
            ...(m.reason && { reason: m.reason }),
          })),
        }),
        ...(layout !== undefined && { layout }),
      } satisfies VmLimits
    },

    async exec(id, command, o = {}): Promise<ExecResult> {
      const timeoutSeconds = o.timeoutSeconds ?? BOAT_MAX_EXEC_SECONDS
      const res = await call(
        `exec ${id}`,
        (init) =>
          sdk.command(
            {
              sandboxId: id,
              commandRequest: {
                command,
                ...(o.cwd !== undefined && { cwd: o.cwd }),
                timeoutSeconds,
              },
            },
            init,
          ),
        { timeoutMs: timeoutSeconds * 1000 + EXEC_GRACE_MS },
      )
      if (!('timedOut' in res))
        throw shapeError('boat', `exec ${id}`, 'answered a sync command as detached')
      return {
        exitCode: res.exitCode ?? null,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        timedOut: res.timedOut,
      }
    },

    async spawn(id, command, o = {}) {
      const res = await call(`spawn ${id}`, (init) =>
        sdk.command(
          {
            sandboxId: id,
            commandRequest: { command, ...(o.cwd !== undefined && { cwd: o.cwd }), detached: true },
          },
          init,
        ),
      )
      if (!('processId' in res) || res.processId === undefined) {
        throw shapeError('boat', `spawn ${id}`, 'answered a detached command as sync')
      }
      return { processId: String(res.processId) }
    },

    async status(id, processId, o = {}): Promise<ProcessStatus> {
      const res = await call(`status ${id}/${processId}`, (init) =>
        sdk.commandStatus(
          { sandboxId: id, processId: Number(processId), tailBytes: o.tailBytes ?? 4096 },
          init,
        ),
      )
      return {
        status: res.status as ProcessStatus['status'],
        running: res.running,
        exitCode: res.exitCode ?? null,
        signal: res.signal ?? null,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      }
    },

    savedSnapshots: {
      async get(name) {
        const got = await orNull(
          call(`snapshot ${name}`, (init) => sdk.getSavedSnapshot({ name }, init)),
        )
        return got?.snapshot ?? null
      },
      async save(sandboxId, name) {
        const saved = await call(`save ${name}`, (init) =>
          sdk.saveSavedSnapshot({ savedSnapshotSaveRequest: { sandboxId, name } }, init),
        )
        return saved.snapshot
      },
      async remove(name) {
        await orNull(
          call(`delete snapshot ${name}`, (init) => sdk.deleteSavedSnapshot({ name }, init)),
        )
      },
      async list() {
        const listed = await call('list snapshots', (init) => sdk.listSavedSnapshots(init))
        return listed.snapshots
      },
    },
  }
}
