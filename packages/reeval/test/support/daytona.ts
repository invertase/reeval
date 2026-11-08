// A fake Daytona API for tests: the routes of `@daytona/sdk` that reeval calls (create, get, list by
// labels, SSH access, TTL and delete) on 127.0.0.1, with Daytona's shapes: a sandbox reports
// `starting` on create and `started` once its machine is up, a list pages with `nextCursor`, and
// every call needs the key as a bearer token. Each sandbox runs as an SSH VM in a container
// (`startSshVm`, ssh-vm.ts) whose SSH access is a token that logs in as the VM's user with no key,
// as Daytona's SSH gateway takes `ssh <token>@ssh.app.daytona.io`. Snapshots go through
// Daytona's states (`pending`, `building`, `active`, `build_failed`, `inactive`, `removing`), and
// a test can seed one in any of them; a sandbox created from a built snapshot or a Dockerfile gets
// a machine of that Dockerfile.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SshVm } from './ssh-vm.ts'

/** Where a sandbox starts from: Daytona's default snapshot, or the Dockerfile it built. */
export type DaytonaSource = { snapshot?: string; dockerfile?: string }

export type DaytonaMachines = (name: string, source: DaytonaSource) => Promise<SshVm>

type FakeSnapshot = {
  id: string
  name: string
  state: string
  errorReason?: string | null
  dockerfile?: string
  resources?: Record<string, unknown>
  /** Reads answer 404 while creates still find the name, as a read lagging another run's create. */
  hidden?: boolean
  /** In GB, as Daytona reports it. */
  size?: number
  createdAt: string
  lastUsedAt?: string
}

/** Builds a Dockerfile, as Daytona's builder does; a rejection is the build's `errorReason`. */
export type DaytonaBuilder = (dockerfile: string) => Promise<void>

type FakeSandbox = {
  id: string
  name: string
  snapshot: string
  /** The Dockerfile the create built, for a sandbox from an image. */
  dockerfile?: string
  resources?: Record<string, unknown>
  autoDeleteInterval?: number
  labels: Record<string, string>
  state: 'starting' | 'pending_build' | 'started' | 'error' | 'build_failed'
  errorReason?: string
  ttlMinutes: number
  autoStopInterval?: number
  ephemeral?: boolean
  machine: Promise<SshVm>
  tokens: string[]
}

export type FakeDaytona = {
  /** DAYTONA_API_URL for reeval. */
  url: string
  key: string
  /** The sandboxes that exist now, by name. */
  live(): string[]
  /** Every sandbox created, with what reeval asked for. */
  created(): Array<
    Pick<FakeSandbox, 'name' | 'snapshot' | 'labels' | 'ttlMinutes'> &
      Partial<
        Pick<FakeSandbox, 'dockerfile' | 'resources' | 'autoStopInterval' | 'autoDeleteInterval'>
      >
  >
  /** The snapshots that exist now, by name. */
  snapshots(): FakeSnapshot[]
  /**
   * Puts snapshot `name` in `state`, as a killed run or another one left it, moving to `settle`'s
   * state after `afterMs`. A `hidden` one answers reads 404 while a create still finds it.
   */
  seedSnapshot(
    name: string,
    o: {
      state: string
      errorReason?: string
      dockerfile?: string
      hidden?: boolean
      settle?: { afterMs: number; state: string; errorReason?: string }
      size?: number
      createdAt?: string
      lastUsedAt?: string
    },
  ): void
  /** Answer every snapshot call 403, as for a key without snapshot permission. */
  refuseSnapshots(): void
  /** Every call, as `METHOD /path`, with what reeval sent that a check reads. */
  requests: Array<{
    call: string
    body?: Record<string, unknown>
    /** Answered 429 by {@link FakeDaytona.refuseStarts}. */
    refused?: true
  }>
  /**
   * Answer the next `count` creates of a name starting `namePrefix` with 429 and
   * `Retry-After: retryAfterSeconds`, as Daytona does past its rate limit.
   */
  refuseStarts(count: number, o?: { namePrefix?: string; retryAfterSeconds?: number }): void
  /** Answer the next `count` calls whose `METHOD /path` matches `call` with 429, as above. */
  refuseCalls(count: number, call: RegExp, o?: { retryAfterSeconds?: number }): void
  close(): Promise<void>
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  body,
  headers,
})

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

const uuid = () =>
  randomBytes(16)
    .toString('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')

export async function fakeDaytona(
  machines: DaytonaMachines,
  options: { key?: string; build?: DaytonaBuilder; buildMs?: number } = {},
): Promise<FakeDaytona> {
  const key = options.key ?? `dtn_test_${randomBytes(8).toString('hex')}`
  const build = options.build ?? (async () => {})
  const buildMs = options.buildMs ?? 50
  const sandboxes = new Map<string, FakeSandbox>()
  const snapshots = new Map<string, FakeSnapshot>()
  let snapshotsRefused = false
  const snapshotView = (s: FakeSnapshot) => ({
    id: s.id,
    organizationId: 'org_test',
    general: false,
    name: s.name,
    imageName: null,
    state: s.state,
    size: s.size ?? null,
    entrypoint: null,
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 8,
    errorReason: s.errorReason ?? null,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
    lastUsedAt: s.lastUsedAt ?? null,
  })
  const later = (ms: number, work: () => void) => {
    setTimeout(work, ms).unref()
  }
  const snapshotRoute = async (
    method: string,
    id: string | undefined,
    sub: string | undefined,
    body: Record<string, unknown> | undefined,
    query: URLSearchParams,
  ) => {
    if (snapshotsRefused) {
      return json(403, { statusCode: 403, message: 'Forbidden: missing write:snapshots' })
    }
    if (!id && method === 'GET') {
      const all = [...snapshots.values()].filter((s) => !s.hidden)
      const limit = Number(query.get('limit') ?? 100)
      const page = Number(query.get('page') ?? 1)
      return json(200, {
        items: all.slice((page - 1) * limit, page * limit).map(snapshotView),
        total: all.length,
        page,
        totalPages: Math.max(1, Math.ceil(all.length / limit)),
      })
    }
    if (!id && method === 'POST') {
      const name = String(body?.name)
      if (snapshots.has(name)) {
        return json(409, { statusCode: 409, message: `Snapshot with name ${name} already exists` })
      }
      const dockerfile = (body?.buildInfo as { dockerfileContent?: string } | undefined)
        ?.dockerfileContent
      const { cpu, memory, disk } = body ?? {}
      const snapshot: FakeSnapshot = {
        id: uuid(),
        name,
        state: 'pending',
        ...(dockerfile !== undefined && { dockerfile }),
        resources: { cpu, memory, disk },
        createdAt: new Date().toISOString(),
      }
      snapshots.set(name, snapshot)
      later(buildMs / 2, () => {
        snapshot.state = 'building'
        build(dockerfile ?? '').then(
          () => later(buildMs / 2, () => (snapshot.state = 'active')),
          (error: Error) => {
            snapshot.state = 'build_failed'
            snapshot.errorReason = error.message
          },
        )
      })
      return json(200, snapshotView(snapshot))
    }
    const snapshot = snapshots.get(id ?? '') ?? [...snapshots.values()].find((s) => s.id === id)
    if (!snapshot || snapshot.hidden) {
      return json(404, { statusCode: 404, message: `Snapshot with ID or name ${id} not found` })
    }
    if (!sub && method === 'GET') return json(200, snapshotView(snapshot))
    if (!sub && method === 'DELETE') {
      snapshot.state = 'removing'
      later(buildMs / 2, () => snapshots.delete(snapshot.name))
      return json(200, {})
    }
    if (sub === 'activate' && method === 'POST') {
      if (snapshot.state !== 'inactive') {
        return json(400, { statusCode: 400, message: `Snapshot ${snapshot.name} is not inactive` })
      }
      snapshot.state = 'pulling'
      later(buildMs, () => (snapshot.state = 'active'))
      return json(200, snapshotView(snapshot))
    }
    return json(404, { statusCode: 404, message: 'Not Found' })
  }
  const created: ReturnType<FakeDaytona['created']> = []
  const requests: FakeDaytona['requests'] = []
  let refusals = { count: 0, namePrefix: '', retryAfterSeconds: 1 }
  let callRefusals = { count: 0, call: /^$/, retryAfterSeconds: 1 }
  let base = ''
  const view = (s: FakeSandbox) => ({
    id: s.id,
    name: s.name,
    organizationId: 'org_test',
    snapshot: s.snapshot,
    user: 'daytona',
    env: {},
    labels: s.labels,
    public: false,
    target: 'us',
    cpu: 2,
    gpu: 0,
    memory: 4,
    disk: 8,
    state: s.state,
    ...(s.errorReason && { errorReason: s.errorReason }),
    autoStopInterval: s.autoStopInterval ?? 15,
    autoDeleteInterval: s.ephemeral ? 0 : -1,
    // Set, so the SDK doesn't ask for it.
    toolboxProxyUrl: `${base}/toolbox`,
  })
  const handle = async (req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/api/, '')
    const method = req.method ?? 'GET'
    const body = method === 'POST' ? await bodyOf(req) : undefined
    requests.push({ call: `${method} ${path}`, ...(body && { body }) })
    if (req.headers.authorization !== `Bearer ${key}`) {
      return json(401, { statusCode: 401, message: 'Invalid API key', error: 'Unauthorized' })
    }
    if (callRefusals.count > 0 && callRefusals.call.test(`${method} ${path}`)) {
      callRefusals.count--
      requests[requests.length - 1].refused = true
      return json(
        429,
        { statusCode: 429, message: 'ThrottlerException: Too Many Requests' },
        { 'retry-after': String(callRefusals.retryAfterSeconds) },
      )
    }
    const [, collection, id, sub, arg] = path.split('/')
    if (collection === 'snapshots') return snapshotRoute(method, id, sub, body, url.searchParams)
    if (collection !== 'sandbox') return json(404, { statusCode: 404, message: 'Not Found' })
    if (
      !id &&
      method === 'POST' &&
      refusals.count > 0 &&
      String(body?.name).startsWith(refusals.namePrefix)
    ) {
      refusals.count--
      requests[requests.length - 1].refused = true
      return json(
        429,
        { statusCode: 429, message: 'ThrottlerException: Too Many Requests' },
        { 'retry-after': String(refusals.retryAfterSeconds) },
      )
    }
    if (!id && method === 'POST') {
      const request = body as {
        name: string
        snapshot?: string
        buildInfo?: { dockerfileContent?: string }
        cpu?: number
        memory?: number
        disk?: number
        labels?: Record<string, string>
        ttlMinutes?: number
        autoStopInterval?: number
        autoDeleteInterval?: number
      }
      const built = request.snapshot ? snapshots.get(request.snapshot) : undefined
      if (
        request.snapshot &&
        !request.snapshot.startsWith('daytona-') &&
        built?.state !== 'active'
      ) {
        return json(400, {
          statusCode: 400,
          message: `Snapshot ${request.snapshot} is ${built?.state ?? 'missing'}`,
        })
      }
      const dockerfile = request.buildInfo?.dockerfileContent ?? built?.dockerfile
      const fromImage = request.buildInfo !== undefined
      const machine = (async () => {
        if (fromImage) await build(dockerfile ?? '')
        return machines(request.name, {
          ...(request.snapshot && { snapshot: request.snapshot }),
          ...(dockerfile !== undefined && { dockerfile }),
        })
      })()
      const resources =
        request.cpu === undefined
          ? undefined
          : { cpu: request.cpu, memory: request.memory, disk: request.disk }
      const sandbox: FakeSandbox = {
        id: uuid(),
        name: request.name,
        snapshot: request.snapshot ?? '',
        ...(dockerfile !== undefined && { dockerfile }),
        ...(resources && { resources }),
        labels: request.labels ?? {},
        state: fromImage ? 'pending_build' : 'starting',
        ttlMinutes: request.ttlMinutes ?? 0,
        ...(request.autoStopInterval !== undefined && {
          autoStopInterval: request.autoStopInterval,
        }),
        ...(request.autoDeleteInterval !== undefined && {
          autoDeleteInterval: request.autoDeleteInterval,
        }),
        ephemeral: request.autoDeleteInterval === 0,
        machine,
        tokens: [],
      }
      sandbox.machine.then(
        () => {
          sandbox.state = 'started'
        },
        (error: Error) => {
          sandbox.state = fromImage ? 'build_failed' : 'error'
          sandbox.errorReason = error.message
        },
      )
      sandboxes.set(sandbox.id, sandbox)
      created.push({
        name: sandbox.name,
        snapshot: sandbox.snapshot,
        labels: sandbox.labels,
        ttlMinutes: sandbox.ttlMinutes,
        ...(dockerfile !== undefined && { dockerfile }),
        ...(resources && { resources }),
        ...(sandbox.autoStopInterval !== undefined && {
          autoStopInterval: sandbox.autoStopInterval,
        }),
        ...(sandbox.autoDeleteInterval !== undefined && {
          autoDeleteInterval: sandbox.autoDeleteInterval,
        }),
      })
      return json(200, view(sandbox))
    }
    if (!id && method === 'GET') {
      const labels = JSON.parse(url.searchParams.get('labels') ?? '{}') as Record<string, string>
      const items = [...sandboxes.values()]
        .filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
        .map(view)
      return json(200, { items, nextCursor: null })
    }
    const sandbox = sandboxes.get(id ?? '') ?? [...sandboxes.values()].find((s) => s.name === id)
    if (!sandbox) {
      return json(404, { statusCode: 404, message: `Sandbox with ID or name ${id} not found` })
    }
    if (!sub && method === 'GET') return json(200, view(sandbox))
    if (sub === 'ssh-access' && method === 'POST') {
      const machine = await sandbox.machine
      const token = `dt${randomBytes(8).toString('hex')}`
      await machine.allowToken(token)
      sandbox.tokens.push(token)
      const [host, port] = machine.endpoint.split(':')
      const minutes = Number(url.searchParams.get('expiresInMinutes') ?? 60)
      return json(200, {
        id: randomBytes(8).toString('hex'),
        sandboxId: sandbox.id,
        token,
        expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sshCommand: `ssh -p ${port} ${token}@${host}`,
      })
    }
    if (sub === 'ttl' && method === 'POST') {
      sandbox.ttlMinutes = Number(arg)
      return json(200, {})
    }
    if (!sub && method === 'DELETE') {
      sandboxes.delete(sandbox.id)
      await (await sandbox.machine.catch(() => null))?.remove()
      return json(200, { ...view(sandbox), state: 'destroying' })
    }
    return json(404, { statusCode: 404, message: 'Not Found' })
  }
  const server: Server = createServer((req, res) => {
    handle(req).then(
      ({ status, body, headers }) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      },
      (error: Error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ statusCode: 500, message: error.message }))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}/api`
  return {
    url: base,
    key,
    live: () => [...sandboxes.values()].map((s) => s.name),
    created: () => created,
    snapshots: () => [...snapshots.values()],
    seedSnapshot(name, o) {
      const snapshot: FakeSnapshot = {
        id: uuid(),
        name,
        state: o.state,
        ...(o.errorReason !== undefined && { errorReason: o.errorReason }),
        ...(o.dockerfile !== undefined && { dockerfile: o.dockerfile }),
        ...(o.hidden && { hidden: true }),
        ...(o.size !== undefined && { size: o.size }),
        createdAt: o.createdAt ?? new Date().toISOString(),
        ...(o.lastUsedAt !== undefined && { lastUsedAt: o.lastUsedAt }),
      }
      snapshots.set(name, snapshot)
      const settle = o.settle
      if (settle) {
        later(settle.afterMs, () => {
          snapshot.state = settle.state
          if (settle.errorReason !== undefined) snapshot.errorReason = settle.errorReason
        })
      }
    },
    refuseSnapshots() {
      snapshotsRefused = true
    },
    requests,
    refuseStarts(count, o = {}) {
      refusals = {
        count,
        namePrefix: o.namePrefix ?? '',
        retryAfterSeconds: o.retryAfterSeconds ?? 1,
      }
    },
    refuseCalls(count, call, o = {}) {
      callRefusals = { count, call, retryAfterSeconds: o.retryAfterSeconds ?? 1 }
    },
    async close() {
      await Promise.all(
        [...sandboxes.values()].map(async (s) => (await s.machine.catch(() => null))?.remove()),
      )
      sandboxes.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
