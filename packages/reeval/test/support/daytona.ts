// A fake Daytona API for tests: the routes of `@daytona/sdk` that reeval calls (create, get, list by
// labels, SSH access, TTL and delete) on 127.0.0.1, with Daytona's shapes: a sandbox reports
// `starting` on create and `started` once its machine is up, a list pages with `nextCursor`, and
// every call needs the key as a bearer token. Each sandbox runs as an SSH VM in a container
// (`startSshVm`, ssh-vm.ts) whose SSH access is a token that logs in as the VM's user with no key,
// as Daytona's SSH gateway takes `ssh <token>@ssh.app.daytona.io`.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SshVm } from './ssh-vm.ts'

export type DaytonaMachines = (name: string) => Promise<SshVm>

type FakeSandbox = {
  id: string
  name: string
  snapshot: string
  labels: Record<string, string>
  state: 'starting' | 'started' | 'error'
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
  created(): Array<Pick<FakeSandbox, 'name' | 'snapshot' | 'labels' | 'ttlMinutes'>>
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

export async function fakeDaytona(
  machines: DaytonaMachines,
  options: { key?: string } = {},
): Promise<FakeDaytona> {
  const key = options.key ?? `dtn_test_${randomBytes(8).toString('hex')}`
  const sandboxes = new Map<string, FakeSandbox>()
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
        labels?: Record<string, string>
        ttlMinutes?: number
        autoStopInterval?: number
        autoDeleteInterval?: number
      }
      const sandbox: FakeSandbox = {
        id: randomBytes(16)
          .toString('hex')
          .replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-'),
        name: request.name,
        snapshot: request.snapshot ?? 'daytona-small',
        labels: request.labels ?? {},
        state: 'starting',
        ttlMinutes: request.ttlMinutes ?? 0,
        ...(request.autoStopInterval !== undefined && {
          autoStopInterval: request.autoStopInterval,
        }),
        ephemeral: request.autoDeleteInterval === 0,
        machine: machines(request.name),
        tokens: [],
      }
      sandbox.machine.then(
        () => {
          sandbox.state = 'started'
        },
        (error: Error) => {
          sandbox.state = 'error'
          sandbox.errorReason = error.message
        },
      )
      sandboxes.set(sandbox.id, sandbox)
      created.push({
        name: sandbox.name,
        snapshot: sandbox.snapshot,
        labels: sandbox.labels,
        ttlMinutes: sandbox.ttlMinutes,
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
