// A fake VM service for cloud()'s tests, in front of the fake Boat API: a bearer token, the calls
// cloud() makes, a strict create body, limits each test picks, a label of its own on every VM
// and any other sandbox a 404, with the upstream's name left out of every error.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeBoat } from './boat.ts'

export const VM_RUN_LABEL = 'reeval.platform.fake-run'
const TYPES = ['small', 'default', 'large', 'xlarge']
const CREATE_KEYS = ['name', 'type', 'ttlSeconds', 'labels', 'noEnv', 'snapshots', 'monitoring']
const LIST_KEYS = ['namePrefix', 'limit', 'cursor']

export type FakeVmLimits = {
  maxLive: number
  maxStarts: number
  maxType: string
  maxTtl: number
  /** Seconds until the token expires; no VM lives past it. */
  tokenTtl: number
  /** The layout `/limits` names, if any: whatever a test sets, read or not. */
  layout?: unknown
}

export type FakeVmService = {
  /** REEVAL_VM_URL. */
  url: string
  /** REEVAL_VM_TOKEN. */
  token: string
  runId: string
  /** Every call the run made, as `METHOD /path`, and the status it got. */
  requests: Array<{ call: string; status: number }>
  /** The run's VMs still up, by id. */
  live(): string[]
  /** Starts the run has made. */
  starts(): number
  /** Ends the run, or its token expires: the token stops working. */
  end(): void
  /** The service ends the run: every create and keep-alive after it is a final `409 code`. */
  stopRun(code: string, message: string, status?: number): void
  /**
   * The next `count` keep-alives take their VM back: a `409 vm_released`, then and at every later
   * keep-alive of it. The VM stays up until the client deletes it.
   */
  reclaim(count: number): void
  close(): Promise<void>
}

const anonymous = (text: string) => text.replace(/boat\.dev|boat|ascii/gi, 'vm').slice(0, 300)

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return Symbol('not json')
  }
}

type Answer = { status: number; body: unknown }
const error = (status: number, code: string, message: string, retryable = false): Answer => ({
  status,
  body: { error: { code, message, retryable } },
})

export async function fakeVmService(
  boat: FakeBoat,
  caps: Partial<FakeVmLimits> = {},
): Promise<FakeVmService> {
  const c: FakeVmLimits = {
    maxLive: 3,
    maxStarts: 20,
    maxType: 'small',
    maxTtl: 3000,
    tokenTtl: 7200,
    ...caps,
  }
  const expiresAt = Date.now() + c.tokenTtl * 1000
  const ttlFor = (asked: unknown) =>
    Math.max(
      1,
      Math.min(Number(asked) || c.maxTtl, c.maxTtl, Math.floor((expiresAt - Date.now()) / 1000)),
    )
  const runId = `run_${randomBytes(4).toString('hex')}`
  const token = randomBytes(16).toString('base64url')
  const owned = new Set<string>()
  const requests: FakeVmService['requests'] = []
  let starts = 0
  let inFlight = 0
  let ended = false
  let stopped: Answer | undefined
  let reclaiming = 0
  const released = new Set<string>()

  const upstream = async (method: string, path: string, body?: unknown, headers = {}) => {
    const res = await fetch(`${boat.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${boat.key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) return { ok: true as const, status: res.status, body: parsed }
    const e = (parsed.error ?? {}) as { code?: string; message?: string }
    return {
      ok: false as const,
      answer: error(
        res.status,
        anonymous(e.code ?? `http_${res.status}`),
        anonymous(e.message ?? 'The VM service refused the call.'),
        res.status === 429 || res.status >= 500,
      ),
    }
  }

  const handle = async (req: IncomingMessage): Promise<Answer> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const body = method === 'POST' || method === 'PATCH' ? await bodyOf(req) : undefined
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (ended || bearer !== token || Date.now() >= expiresAt) {
      return error(401, 'unauthorized', 'The token is not valid for a live run.')
    }
    const [, collection, id, sub, ...rest] = url.pathname.replace(/^\/vm/, '').split('/')
    const notFound = error(404, 'not_found', 'No such VM.')
    if (collection === 'limits' && !id && method === 'GET') {
      const allowed = TYPES.slice(0, TYPES.indexOf(c.maxType) + 1)
      const canStart = starts < c.maxStarts
      return {
        status: 200,
        body: {
          ok: true,
          canStart,
          ...(canStart ? {} : { startBlockedReason: `The run used its ${c.maxStarts} VM starts.` }),
          activeSandboxes: owned.size + inFlight,
          maxActiveSandboxes: c.maxLive,
          startLimits: { perHour: c.maxStarts },
          starts: { hour: { used: starts } },
          machineTypes: TYPES.map((type) => ({
            type,
            available: allowed.includes(type),
            reason: allowed.includes(type) ? null : `A run's VMs may be at most ${c.maxType}.`,
          })),
          ...(c.layout !== undefined && { layout: c.layout }),
        },
      }
    }
    if (collection !== 'sandboxes' || rest.length)
      return error(404, 'not_found', 'Not a VM API call.')
    if (!id && method === 'POST') {
      const b = body as Record<string, unknown> | undefined
      const bad =
        !b ||
        typeof b !== 'object' ||
        Object.keys(b).some((k) => !CREATE_KEYS.includes(k)) ||
        (b.type !== undefined && !TYPES.includes(String(b.type))) ||
        (b.noEnv !== undefined && b.noEnv !== true) ||
        (b.snapshots !== undefined && b.snapshots !== false) ||
        (b.labels !== undefined && Object.keys(b.labels as object).length > 16) ||
        Object.keys((b.labels ?? {}) as object).some((k) =>
          k.toLowerCase().startsWith('reeval.platform.'),
        ) ||
        String(b.name ?? '')
          .toLowerCase()
          .startsWith('reeval-run-')
      if (bad) return error(400, 'invalid_request', `Not a create body: ${JSON.stringify(b)}`)
      if (stopped) return stopped
      const type = String(b.type ?? 'small')
      if (TYPES.indexOf(type) > TYPES.indexOf(c.maxType)) {
        return error(403, 'forbidden', `A run's VMs may be at most ${c.maxType}.`)
      }
      if (starts >= c.maxStarts)
        return error(403, 'forbidden', `A run may start ${c.maxStarts} VMs.`)
      if (owned.size + inFlight >= c.maxLive) {
        return error(429, 'rate_limited', `A run may have ${c.maxLive} VMs at once.`, true)
      }
      starts++
      inFlight++
      const ttlSeconds = ttlFor(b.ttlSeconds)
      const idempotency = req.headers['idempotency-key']
      const made = await upstream(
        'POST',
        '/sandboxes',
        {
          ...b,
          ttlSeconds,
          labels: { ...(b.labels as object), [VM_RUN_LABEL]: runId },
        },
        idempotency ? { 'idempotency-key': `${runId}:${idempotency}` } : {},
      ).finally(() => inFlight--)
      if (!made.ok) return made.answer
      const sandbox = made.body.sandbox as { id: string }
      owned.add(sandbox.id)
      return { status: made.status, body: { ...made.body, ttlSeconds } }
    }
    if (!id && method === 'GET') {
      if ([...url.searchParams.keys()].some((k) => !LIST_KEYS.includes(k))) {
        return error(400, 'invalid_request', 'Unknown query parameter.')
      }
      const listed = await upstream('GET', `/sandboxes?${url.searchParams}`)
      if (!listed.ok) return listed.answer
      const sandboxes = (listed.body.sandboxes as Array<{ id: string }>).filter((s) =>
        owned.has(s.id),
      )
      return { status: 200, body: { ...listed.body, sandboxes } }
    }
    if (!id || !owned.has(id)) return notFound
    const path = `/sandboxes/${encodeURIComponent(id)}`
    if (sub === 'sshkey' && method === 'POST') {
      const got = await upstream('POST', `${path}/sshkey`, body)
      return got.ok ? { status: 200, body: got.body } : got.answer
    }
    if (sub) return error(404, 'not_found', 'Not a VM API call.')
    if (method === 'GET') {
      const got = await upstream('GET', path)
      return got.ok ? { status: 200, body: got.body } : got.answer
    }
    if (method === 'PATCH') {
      const b = body as Record<string, unknown> | undefined
      if (!b || Object.keys(b).some((k) => k !== 'ttlSeconds')) {
        return error(400, 'invalid_request', 'Only ttlSeconds can change.')
      }
      if (stopped) return stopped
      if (reclaiming > 0 && !released.has(id)) {
        reclaiming--
        released.add(id)
      }
      if (released.has(id)) {
        return error(409, 'vm_released', 'The run holds 2 VMs, more than its 1 now.')
      }
      const ttlSeconds = ttlFor(b.ttlSeconds)
      const got = await upstream('PATCH', path, { ttlSeconds })
      return got.ok ? { status: 200, body: got.body } : got.answer
    }
    if (method === 'DELETE') {
      const got = await upstream('DELETE', path, undefined, { 'x-ascii-confirm-delete': id })
      if (!got.ok) return got.answer
      owned.delete(id)
      return { status: 200, body: got.body }
    }
    return error(404, 'not_found', 'Not a VM API call.')
  }

  const server: Server = createServer((req, res) => {
    handle(req).then(
      (answer) => {
        requests.push({
          call: `${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`,
          status: answer.status,
        })
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      },
      (e: Error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify(error(500, 'internal', anonymous(e.message), true).body))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/vm`,
    token,
    runId,
    requests,
    live: () => [...owned],
    starts: () => starts,
    end() {
      ended = true
    },
    stopRun(code, message, status = 409) {
      stopped = error(status, code, message)
    },
    reclaim(count) {
      reclaiming = count
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
