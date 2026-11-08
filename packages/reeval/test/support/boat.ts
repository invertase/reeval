// A fake Boat API for tests: the routes of `@boatdev/sdk` that reeval calls (create, get, sshkey,
// list by name prefix, update, delete, limits and saved snapshots) on 127.0.0.1, with Boat's own shapes and quirks: a
// sandbox reports `starting` before `ready`, a delete needs `X-Ascii-Confirm-Delete`, and every
// call needs the key as a bearer token. Where its sandboxes run is up to `machines`: an SSH VM in a
// container (`startSshVm`, ssh-vm.ts), or an address nothing listens on (`unreachableMachines`),
// for the lifecycle without Docker. Each answers with a `machineIp` in IPv6's documentation range
// ({@link NO_ROUTE_IP}), which no host reaches, so every attempt falls back to the endpoint as one
// on a host without IPv6 does. `boatSandboxesLeft` asks the real one, for the contract's rows in
// boat().
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { boatClient, DEAD_STATES, runPrefix } from '../../src/sandbox/boat.ts'
import { boat } from '../../src/sandbox-boat.ts'
import type { SshVm } from './ssh-vm.ts'

export type Machines = (name: string) => Promise<SshVm>

type FakeSandbox = {
  id: string
  name: string
  type: string
  state: 'starting' | 'ready' | 'error'
  error?: string
  ttlSeconds: number
  machine: Promise<SshVm>
  /** `get` calls answered, so the first says `starting`. */
  polls: number
}

export type FakeSnapshot = {
  name: string
  status: 'saving' | 'ready' | 'failed'
  error?: string
  sourceSandboxId: string
  /** The saved sandbox's name, as the snapshot's own record of where it came from. */
  sourceName?: string
  sizeBytes?: number
  /** `get` calls still to answer `saving`. */
  polls: number
  createdAt?: string
}

export type FakeBoat = {
  /** BOAT_BASE_URL for reeval. */
  url: string
  key: string
  /** The sandboxes that exist now, by name. */
  live(): string[]
  /** Every call, as `METHOD /path`, with what reeval sent that a check reads. */
  requests: Array<{
    call: string
    idempotencyKey?: string
    body?: Record<string, unknown>
    /** Answered 429 by {@link FakeBoat.refuseStarts}. */
    refused?: true
  }>
  /**
   * Saved snapshots by name. A save reports `saving` for its first `savePolls` gets, then `ready`
   * with the sandbox it was saved from, or `failed` when {@link FakeBoat.failSaves} says so.
   */
  snapshots: Map<string, FakeSnapshot>
  /** The next `count` saves fail with `error`, as a save Boat couldn't capture. */
  failSaves(count: number, error?: string): void
  /**
   * The next `count` saves find another run saving the same name, and are answered 409
   * `save_in_progress`, as Boat refuses a name while a save of it is in progress. A save of a
   * name whose snapshot is ready replaces it.
   */
  loseSaves(count: number): void
  /**
   * Answer the next `count` creates of a name starting `namePrefix` with 429 and
   * `Retry-After: retryAfterSeconds`, as Boat does past a start limit.
   */
  refuseStarts(count: number, o?: { namePrefix?: string; retryAfterSeconds?: number }): void
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

export async function fakeBoat(
  machines: Machines,
  options: {
    key?: string
    maxActive?: number
    savePolls?: number
    /** Where a sandbox that can be saved, or starts from a saved snapshot, runs; `machines` unset. */
    saved?: Machines
  } = {},
): Promise<FakeBoat> {
  const key = options.key ?? `boat_test_${randomBytes(8).toString('hex')}`
  const sandboxes = new Map<string, FakeSandbox>()
  const requests: FakeBoat['requests'] = []
  let refusals = { count: 0, namePrefix: '', retryAfterSeconds: 1 }
  const snapshots = new Map<string, FakeSnapshot>()
  const snapshotsOn = new Set<string>()
  let saveFailures = { count: 0, error: 'capture failed' }
  let lostSaves = 0
  const snapshotView = (s: FakeSnapshot) => ({
    name: s.name,
    status: s.status,
    sourceSandboxId: s.sourceSandboxId,
    createdAt: s.createdAt ?? new Date(0).toISOString(),
    ...(s.error && { error: s.error }),
    ...(s.sizeBytes !== undefined && { sizeBytes: s.sizeBytes }),
  })
  const view = (s: FakeSandbox) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    state: s.state,
    ttlSeconds: s.ttlSeconds,
    ...(s.error && { error: s.error }),
  })
  const handle = async (req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const method = req.method ?? 'GET'
    const body = method === 'POST' || method === 'PATCH' ? await bodyOf(req) : undefined
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined
    requests.push({
      call: `${method} ${path}`,
      ...(idempotencyKey && { idempotencyKey }),
      ...(body && { body }),
    })
    if (req.headers.authorization !== `Bearer ${key}`) {
      return json(401, { error: { code: 'unauthorized', message: 'invalid API key' } })
    }
    const [, collection, id, sub] = path.split('/')
    if (collection === 'limits' && method === 'GET') {
      return json(200, {
        canStart: true,
        activeSandboxes: sandboxes.size,
        maxActiveSandboxes: options.maxActive ?? 10,
        machineTypes: [
          { type: 'small', available: true, reason: null },
          { type: 'large', available: false, reason: 'not on this plan' },
        ],
      })
    }
    if (collection === 'saved-snapshots') {
      if (!id && method === 'GET') {
        return json(200, {
          ok: true,
          type: 'snapshot.saved.list',
          snapshots: [...snapshots.values()].map(snapshotView),
        })
      }
      if (!id && method === 'POST') {
        const request = body as { sandboxId: string; name: string }
        const source = sandboxes.get(request.sandboxId)
        if (!source) return json(404, { error: { code: 'not_found' } })
        if (!snapshotsOn.has(source.id)) {
          return json(409, {
            error: { code: 'snapshots_disabled', message: 'this sandbox has snapshots off' },
          })
        }
        if (lostSaves > 0) {
          lostSaves--
          snapshots.set(request.name, {
            name: request.name,
            status: 'saving',
            sourceSandboxId: 'bx_other_run',
            sizeBytes: 300_000_000,
            polls: options.savePolls ?? 1,
          })
        }
        if (snapshots.get(request.name)?.status === 'saving') {
          return json(409, {
            error: {
              code: 'save_in_progress',
              message: `"${request.name}" is already being saved. Wait for it to finish.`,
            },
          })
        }
        const failing = saveFailures.count > 0
        if (failing) saveFailures.count--
        const snapshot: FakeSnapshot = {
          name: request.name,
          status: 'saving',
          sourceSandboxId: source.id,
          sourceName: source.name,
          polls: options.savePolls ?? 1,
          createdAt: new Date().toISOString(),
          ...(failing && { error: saveFailures.error }),
        }
        snapshots.set(request.name, snapshot)
        return json(202, {
          ok: true,
          type: 'snapshot.saved.saving',
          status: 'saving',
          snapshot: snapshotView(snapshot),
        })
      }
      const snapshot = snapshots.get(decodeURIComponent(id ?? ''))
      if (!snapshot) {
        return json(404, { error: { code: 'snapshot_not_found', message: `no snapshot ${id}` } })
      }
      if (method === 'GET') {
        if (snapshot.status === 'saving' && snapshot.polls-- <= 0) {
          snapshot.status = snapshot.error ? 'failed' : 'ready'
          if (snapshot.status === 'ready') snapshot.sizeBytes ??= 400_000_000
        }
        return json(200, {
          ok: true,
          type: 'snapshot.saved.info',
          snapshot: snapshotView(snapshot),
        })
      }
      if (method === 'DELETE') {
        snapshots.delete(snapshot.name)
        return json(200, { ok: true })
      }
    }
    if (collection !== 'sandboxes') return json(404, { error: { code: 'not_found' } })
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
        { error: { code: 'rate_limited', message: 'too many sandbox starts this minute' } },
        { 'retry-after': String(refusals.retryAfterSeconds) },
      )
    }
    if (!id && method === 'POST') {
      const request = body as {
        name: string
        type?: string
        ttlSeconds?: number
        snapshots?: boolean
        from?: string
      }
      const existing = [...sandboxes.values()].find((s) => s.name === request.name)
      if (existing) return json(200, { ok: true, sandbox: view(existing) })
      if (request.from !== undefined && snapshots.get(request.from)?.status !== 'ready') {
        return json(404, {
          error: { code: 'snapshot_not_found', message: `no saved snapshot ${request.from}` },
        })
      }
      const start = (request.from !== undefined || request.snapshots) && options.saved
      const sandbox: FakeSandbox = {
        id: `bx_${randomBytes(4).toString('hex')}`,
        name: request.name,
        type: request.type ?? 'small',
        state: 'starting',
        ttlSeconds: request.ttlSeconds ?? 3600,
        machine: (start || machines)(request.name),
        polls: 0,
      }
      sandbox.machine.then(
        () => {
          sandbox.state = 'ready'
        },
        (error: Error) => {
          sandbox.state = 'error'
          sandbox.error = error.message
        },
      )
      sandboxes.set(sandbox.id, sandbox)
      if (request.snapshots) snapshotsOn.add(sandbox.id)
      return json(201, { ok: true, type: sandbox.type, status: 'starting', sandbox: view(sandbox) })
    }
    if (!id && method === 'GET') {
      const prefix = url.searchParams.get('namePrefix') ?? ''
      const list = [...sandboxes.values()].filter((s) => s.name.startsWith(prefix)).map(view)
      return json(200, { sandboxes: list, pageInfo: { nextCursor: null, hasMore: false } })
    }
    const sandbox = sandboxes.get(id ?? '')
    if (!sandbox) return json(404, { error: { code: 'not_found', message: `no sandbox ${id}` } })
    if (!sub && method === 'GET') {
      if (sandbox.polls++ === 0)
        return json(200, { sandbox: { ...view(sandbox), state: 'starting' } })
      return json(200, { sandbox: view(sandbox) })
    }
    if (sub === 'sshkey' && method === 'POST') {
      const machine = await sandbox.machine
      await machine.authorize(String((body as { key?: string }).key))
      return json(200, {
        sshUser: machine.user,
        machineIp: NO_ROUTE_IP,
        sshEndpoint: machine.endpoint,
        hostKey: machine.hostKey,
      })
    }
    if (!sub && method === 'PATCH') {
      const ttlSeconds = (body as { ttlSeconds?: number }).ttlSeconds
      if (ttlSeconds) sandbox.ttlSeconds = ttlSeconds
      return json(200, { sandbox: view(sandbox) })
    }
    if (!sub && method === 'DELETE') {
      if (req.headers['x-ascii-confirm-delete'] !== sandbox.id) {
        return json(400, {
          error: {
            code: 'confirm_required',
            message: 'X-Ascii-Confirm-Delete must be the sandbox id',
          },
        })
      }
      sandboxes.delete(sandbox.id)
      await (await sandbox.machine.catch(() => null))?.remove()
      return json(200, { ok: true })
    }
    return json(404, { error: { code: 'not_found' } })
  }
  const server: Server = createServer((req, res) => {
    handle(req).then(
      ({ status, body, headers }) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      },
      (error: Error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'internal', message: error.message } }))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    key,
    live: () => [...sandboxes.values()].map((s) => s.name),
    requests,
    snapshots,
    failSaves(count, error = 'capture failed') {
      saveFailures = { count, error }
    },
    loseSaves(count) {
      lostSaves = count
    },
    refuseStarts(count, o = {}) {
      refusals = {
        count,
        namePrefix: o.namePrefix ?? '',
        retryAfterSeconds: o.retryAfterSeconds ?? 1,
      }
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

/** An address in IPv6's documentation range (RFC 3849): routed nowhere. */
export const NO_ROUTE_IP = '2001:db8::1'

/** Machines whose SSH endpoint nothing listens on: Boat's side of the lifecycle, without a VM. */
export const unreachableMachines: Machines = async () => ({
  endpoint: '127.0.0.1:1',
  user: 'user',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOkVnNvZ8lfy5H2wK0ljJm0cz6dJ7l4LwW8kQx2bH9oD',
  authorize: async () => {},
  allowToken: async () => {},
  remove: async () => {},
})

/**
 * The run's sandboxes still live on the real Boat account in BOAT_API_KEY (or the one
 * BOAT_BASE_URL points at), by name: every one not in a state it never leaves, since one still
 * provisioning when reeval deleted it can come up idle minutes later. Waits up to `deadlineMs`
 * for deletes to land.
 */
export async function boatSandboxesLeft(runId: string, deadlineMs = 30_000): Promise<string[]> {
  const sandbox = boat()
  const api = await boatClient(sandbox)
  const prefix = runPrefix(sandbox, runId)
  const until = Date.now() + deadlineMs
  let left: string[] = []
  do {
    const { sandboxes } = await api.sandboxes({ namePrefix: prefix, limit: 100 })
    left = sandboxes
      .filter((s) => s.name.startsWith(prefix) && !DEAD_STATES.includes(s.state))
      .map((s) => `${s.name} (${s.state})`)
    if (!left.length) return []
    await new Promise((r) => setTimeout(r, 1000))
  } while (Date.now() < until)
  return left
}
