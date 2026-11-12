import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BoatApi, Configuration } from '@boatdev/sdk'
import { boatApi, boatSshRoutes } from '../src/boat.ts'
import { VmApiError } from '../src/index.ts'
import { stubFetch } from './stub.ts'

const KEY = 'boat_test_key'

/** The adapter over an SDK client that sends its calls to `fetch`. */
const client = (o: { fetch: typeof fetch; baseUrl?: string; timeoutMs?: number }) =>
  boatApi(
    new BoatApi(
      new Configuration({
        basePath: o.baseUrl ?? 'https://boat.dev/api/v1',
        accessToken: KEY,
        fetchApi: o.fetch,
      }),
    ),
    o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs },
  )
const sandbox = (state: string, extra: Record<string, unknown> = {}) => ({
  id: 'bx_1',
  name: 'reeval-run-1',
  state,
  labels: { 'reeval.run': '1' },
  ...extra,
})

describe('boatApi', () => {
  test('creates with the idempotency key, keeps the environment out of logs and reads the TTL', async () => {
    const { fetch, sent } = stubFetch(() => ({
      body: { sandbox: sandbox('provisioning', { ttlSeconds: 600 }), ttlSeconds: 900 },
    }))
    const api = client({ baseUrl: 'http://boat.test/api/v1', fetch })
    const vm = await api.create({
      name: 'reeval-run-1',
      size: 'large',
      labels: { 'reeval.run': '1' },
      ttlSeconds: 900,
      idempotencyKey: 'reeval-run-1',
      saveable: true,
      from: 'snap',
    })
    assert.deepEqual(vm, {
      id: 'bx_1',
      name: 'reeval-run-1',
      state: 'starting',
      raw: 'provisioning',
      labels: { 'reeval.run': '1' },
      ttlSeconds: 900,
    })
    const [request] = sent
    assert.equal(request?.method, 'POST')
    assert.equal(request?.url.href, 'http://boat.test/api/v1/sandboxes')
    assert.equal(request?.headers.authorization, `Bearer ${KEY}`)
    assert.equal(request?.headers['idempotency-key'], 'reeval-run-1')
    assert.deepEqual(request?.body, {
      type: 'large',
      name: 'reeval-run-1',
      ttlSeconds: 900,
      labels: { 'reeval.run': '1' },
      noEnv: true,
      snapshots: true,
      monitoring: false,
      from: 'snap',
    })
  })

  test('reads states as ready, dead or starting, and a 404 as gone', async () => {
    const states: Record<string, unknown> = {
      a: sandbox('idle'),
      b: sandbox('archived', { error: 'out of disk' }),
      c: sandbox('booting'),
    }
    const { fetch } = stubFetch(({ url }) => {
      const id = url.pathname.split('/').at(-1) ?? ''
      return id in states
        ? { body: { sandbox: states[id] } }
        : { status: 404, body: { code: 'not_found', message: 'no such sandbox' } }
    })
    const api = client({ fetch })
    assert.equal((await api.get('a'))?.state, 'ready')
    assert.deepEqual(await api.get('b').then((v) => [v?.state, v?.error]), ['dead', 'out of disk'])
    assert.equal((await api.get('c'))?.state, 'starting')
    assert.equal(await api.get('gone'), null)
  })

  test('confirms a delete and takes a 404 as deleted', async () => {
    const { fetch, sent } = stubFetch(() => ({ status: 404, body: { code: 'not_found' } }))
    await client({ fetch }).remove('bx_1')
    assert.equal(sent[0]?.method, 'DELETE')
    assert.equal(sent[0]?.headers['x-ascii-confirm-delete'], 'bx_1')
  })

  test('lists every page by name prefix and labels', async () => {
    const { fetch, sent } = stubFetch(({ url }) =>
      url.searchParams.get('cursor')
        ? { body: { sandboxes: [sandbox('ready', { id: 'bx_2', name: 'reeval-run-2' })] } }
        : {
            body: {
              sandboxes: [sandbox('ready'), sandbox('ready', { id: 'bx_x', name: 'other' })],
              pageInfo: { nextCursor: 'p2', hasMore: true },
            },
          },
    )
    const api = client({ fetch })
    const ids: string[] = []
    for await (const vm of api.list({ namePrefix: 'reeval-', labels: { a: '1', b: '2' } })) {
      ids.push(vm.id)
    }
    assert.deepEqual(ids, ['bx_1', 'bx_2'])
    assert.deepEqual(sent[0]?.url.searchParams.getAll('label'), ['a=1', 'b=2'])
    assert.equal(sent[0]?.url.searchParams.get('namePrefix'), 'reeval-')
    assert.equal(sent[1]?.url.searchParams.get('cursor'), 'p2')
  })

  test('normalizes the limits, preferring the wallet start limits', async () => {
    const { fetch } = stubFetch(() => ({
      body: {
        canStart: false,
        startBlockedReason: 'wallet empty',
        activeSandboxes: 3,
        maxActiveSandboxes: 10,
        startLimits: { perMinute: 5, perHour: 50 },
        startLimitsWithWallet: { perMinute: 2, perHour: 20 },
        starts: { hour: { used: 7 } },
        machineTypes: [{ type: 'xlarge', available: false, reason: 'not on this plan' }],
      },
    }))
    assert.deepEqual(await client({ fetch }).limits(), {
      canStart: false,
      blockedReason: 'wallet empty',
      live: 3,
      maxLive: 10,
      startsPerMinute: 2,
      startsPerHour: 20,
      startsThisHour: 7,
      sizes: [{ size: 'xlarge', available: false, reason: 'not on this plan' }],
    })
  })

  test('authorizes a key and answers its routes, user and trimmed host key', async () => {
    const { fetch, sent } = stubFetch(() => ({
      body: {
        sshUser: 'reeval',
        machineIp: '2001:db8::24',
        sshEndpoint: '198.51.100.7:19036',
        hostKey: 'ssh-ed25519 AAAA\n',
      },
    }))
    const ssh = await client({ fetch }).sshAccess('bx_1', {
      publicKey: 'ssh-ed25519 PUB',
      minutes: 30,
    })
    assert.deepEqual(sent[0]?.body, { key: 'ssh-ed25519 PUB' })
    assert.deepEqual(ssh, {
      user: 'reeval',
      routes: [
        { host: '2001:db8::24', port: 22, via: 'machine address' },
        { host: '198.51.100.7', port: 19036, via: 'public endpoint' },
      ],
      hostKey: 'ssh-ed25519 AAAA',
      auth: 'key',
    })
  })
})

describe("boatApi's errors", () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    client({ fetch: stubFetch(() => ({ status, body, headers })).fetch })

  test('a start limit is rate-limited, with when to try again', async () => {
    const before = Date.now()
    const error = await failing(
      429,
      { code: 'rate_limited', message: 'slow down' },
      { 'retry-after': '7' },
    )
      .create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
      .catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.equal(error.kind, 'rate-limited')
    assert.equal(error.retryable, true)
    assert.equal(error.detail, '429 rate_limited: slow down')
    assert.equal(error.summary, 'boat create: 429 rate_limited')
    assert.ok((error.retryAt ?? 0) >= before + 7000)
  })

  test("a 403 is the account's quota, and the body's nextStartAt says when", async () => {
    const at = new Date(Date.now() + 60_000).toISOString()
    const error = await failing(403, {
      error: { code: 'start_limit', message: 'cap', nextStartAt: at },
    })
      .create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
      .catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.equal(error.kind, 'quota')
    assert.equal(error.code, 'start_limit')
    assert.equal(error.retryAt, Date.parse(at))
  })

  test("a 403 on another call is auth, not quota, and a nested retryable is the body's word", async () => {
    const foreign = await failing(403, { error: { code: 'forbidden', message: 'not yours' } })
      .get('bx_9')
      .catch((e: unknown) => e)
    assert.ok(foreign instanceof VmApiError)
    assert.deepEqual([foreign.kind, foreign.retryAt], ['auth', undefined])
    const stopped = await failing(409, {
      error: { code: 'run_deadline', message: 'over', retryable: true },
    })
      .create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
      .catch((e: unknown) => e)
    assert.ok(stopped instanceof VmApiError)
    assert.deepEqual([stopped.code, stopped.retryable], ['run_deadline', true])
  })

  test('out of capacity is retryable, and a direct command failure is not', async () => {
    const capacity = await failing(503, { code: 'out_of_capacity' })
      .get('bx_1')
      .catch((e: unknown) => e)
    assert.ok(capacity instanceof VmApiError)
    assert.deepEqual([capacity.kind, capacity.retryable], ['capacity', true])
    const direct = await failing(502, { code: 'boat_direct_failed' })
      .exec('bx_1', 'true')
      .catch((e: unknown) => e)
    assert.ok(direct instanceof VmApiError)
    assert.equal(direct.retryable, false)
  })

  test('a refused key is auth, and a body that is not JSON keeps its text', async () => {
    const error = await failing(401, undefined)
      .get('bx_1')
      .catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.deepEqual([error.kind, error.code], ['auth', 'http_401'])
  })

  test('no response is a network error, and an abort throws its own reason', async () => {
    const down = client({
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })
      }) as typeof fetch,
    })
    const error = await down.get('bx_1').catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.deepEqual([error.kind, error.status, error.detail], ['network', 0, 'ECONNREFUSED'])
    const reason = new Error('attempt canceled')
    const canceled = new AbortController()
    canceled.abort(reason)
    const api = client({ fetch: stubFetch(() => ({ body: {} })).fetch })
    await assert.rejects(api.get('bx_1', { signal: canceled.signal }), reason)
  })
})

describe('boatSshRoutes', () => {
  test("tries the machine's own address on port 22 first, then the public endpoint", () => {
    assert.deepEqual(
      boatSshRoutes({ machineIp: '2001:db8::24', sshEndpoint: '198.51.100.7:19036' }),
      [
        { host: '2001:db8::24', port: 22, via: 'machine address' },
        { host: '198.51.100.7', port: 19036, via: 'public endpoint' },
      ],
    )
    assert.deepEqual(boatSshRoutes({ sshEndpoint: '[2001:db8::7]:2222', machineIp: null }), [
      { host: '2001:db8::7', port: 2222, via: 'public endpoint' },
    ])
    assert.deepEqual(boatSshRoutes({ machineIp: '198.51.100.9' }), [
      { host: '198.51.100.9', port: 22, via: 'machine address' },
    ])
    assert.deepEqual(boatSshRoutes({ sshEndpoint: 'no-port' }), [])
  })
})
