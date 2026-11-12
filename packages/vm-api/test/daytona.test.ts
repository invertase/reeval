import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Daytona, Sandbox } from '@daytona/sdk'
import { daytonaApi, daytonaSshTarget } from '../src/daytona.ts'
import { VmApiError } from '../src/index.ts'

/** The SDK's error classes, by the fields and names the adapter reads. */
class DaytonaError extends Error {
  statusCode?: number | undefined
  headers?: Map<string, string> | undefined
  code?: string | undefined
  source?: string | undefined
  constructor(message: string, statusCode?: number, headers?: Map<string, string>, code?: string) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.headers = headers
    this.code = code
    this.source = undefined
  }
}
class DaytonaNotFoundError extends DaytonaError {}
class DaytonaRateLimitError extends DaytonaError {}
class DaytonaAuthenticationError extends DaytonaError {}
class DaytonaConnectionError extends DaytonaError {}
class DaytonaValidationError extends DaytonaError {}
class DaytonaTimeoutError extends DaytonaError {
  sandboxId?: string
}

type Call = [string, ...unknown[]]

/** The members of the SDK's `Sandbox` and `Daytona` the adapter uses. */
type FakeSandbox = Pick<
  Sandbox,
  'id' | 'name' | 'state' | 'errorReason' | 'labels' | 'createSshAccess' | 'setTtl' | 'delete'
>
type FakeClient = {
  create(params: Record<string, unknown>, options: { timeout: number }): Promise<FakeSandbox>
  get(id: string): Promise<FakeSandbox>
  list(query: unknown): AsyncIterable<FakeSandbox>
}
const adapter = (client: FakeClient, o?: { startTimeoutSeconds?: number }) =>
  daytonaApi(client as unknown as Daytona, o)

function fakeClient(sandboxes: Record<string, Partial<FakeSandbox>> = {}) {
  const calls: Call[] = []
  const notFound = () => new DaytonaNotFoundError('Sandbox not found', 404)
  const sandbox = (id: string): FakeSandbox => ({
    id,
    name: id,
    state: 'started',
    async createSshAccess(minutes) {
      calls.push(['ssh-access', id, minutes])
      return { token: 'tok123', sshCommand: 'ssh -p 2222 tok123@ssh.app.daytona.io' }
    },
    async setTtl(minutes) {
      calls.push(['ttl', id, minutes])
    },
    async delete() {
      calls.push(['delete', id])
    },
    ...sandboxes[id],
  })
  const client: FakeClient = {
    async create(params, options) {
      calls.push(['create', params, options])
      return { ...sandbox('d1'), name: params.name, labels: params.labels }
    },
    async get(id) {
      calls.push(['get', id])
      if (!(id in sandboxes)) throw notFound()
      return sandbox(id)
    },
    async *list(query) {
      calls.push(['list', query])
      for (const id of Object.keys(sandboxes)) yield sandbox(id)
    },
  }
  return { client, calls }
}

describe('daytonaApi', () => {
  test("creates from the size's snapshot with no idle stop, deleted once it stops", async () => {
    const { client, calls } = fakeClient()
    const vm = await adapter(client).create({
      name: 'reeval-run-1',
      size: 'medium',
      labels: { a: '1' },
      ttlSeconds: 601,
      env: { X: '1' },
    })
    assert.deepEqual(vm, {
      id: 'd1',
      name: 'reeval-run-1',
      state: 'ready',
      raw: 'started',
      labels: { a: '1' },
    })
    assert.deepEqual(calls, [
      [
        'create',
        {
          name: 'reeval-run-1',
          snapshot: 'daytona-medium',
          labels: { a: '1' },
          envVars: { X: '1' },
          autoStopInterval: 0,
          autoDeleteInterval: 0,
          ttlMinutes: 11,
        },
        { timeout: 120 },
      ],
    ])
  })

  test('a canceled create rejects with its reason and deletes the sandbox made after', async () => {
    const { client, calls } = fakeClient()
    let made: (s: FakeSandbox) => void = () => {}
    const slow: FakeClient = {
      ...client,
      create: () => new Promise((resolve) => (made = resolve)),
    }
    const controller = new AbortController()
    const creating = adapter(slow).create(
      { name: 'n', size: 'small', labels: {}, ttlSeconds: 60 },
      { signal: controller.signal },
    )
    controller.abort(new Error('canceled'))
    await assert.rejects(creating, /canceled/)
    made(await client.create({} as never, { timeout: 1 }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls.at(-1), ['delete', 'd1'])
  })

  test('reads started as ready, a stopped or failed one as dead, and a 404 as gone', async () => {
    const api = adapter(
      fakeClient({
        a: {},
        b: { state: 'build_failed', errorReason: 'bad Dockerfile' },
        c: { state: 'pending_build' },
      }).client,
    )
    assert.equal((await api.get('a'))?.state, 'ready')
    assert.deepEqual(await api.get('b').then((v) => [v?.state, v?.error]), [
      'dead',
      'bad Dockerfile',
    ])
    assert.equal((await api.get('c'))?.state, 'starting')
    assert.equal(await api.get('gone'), null)
  })

  test('answers SSH access as a token login through the gateway, with no host key', async () => {
    const { client, calls } = fakeClient({ d1: {} })
    const ssh = await adapter(client).sshAccess('d1', { publicKey: 'ignored', minutes: 45 })
    assert.deepEqual(calls, [
      ['get', 'd1'],
      ['ssh-access', 'd1', 45],
    ])
    assert.deepEqual(ssh, {
      user: 'tok123',
      routes: [{ host: 'ssh.app.daytona.io', port: 2222, via: "Daytona's SSH gateway" }],
      auth: 'token',
    })
  })

  test('sets the TTL in whole minutes on the sandbox it made, and takes a gone one as deleted', async () => {
    const { client, calls } = fakeClient()
    const api = adapter(client)
    await api.create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
    assert.deepEqual(await api.setTtl('d1', 61), {})
    await api.remove('d1')
    await api.remove('d1')
    assert.deepEqual(calls.slice(1), [
      ['ttl', 'd1', 2],
      ['delete', 'd1'],
      ['get', 'd1'],
    ])
  })

  test('lists by labels, filtering the name prefix itself', async () => {
    const { client, calls } = fakeClient({ 'reeval-1': {}, other: {}, 'reeval-2': {} })
    const ids: string[] = []
    for await (const vm of adapter(client).list({
      namePrefix: 'reeval-',
      labels: { run: '1' },
    })) {
      ids.push(vm.id)
    }
    assert.deepEqual(ids, ['reeval-1', 'reeval-2'])
    assert.deepEqual(calls, [['list', { labels: { run: '1' }, limit: 100 }]])
  })

  test('a throttled call is rate-limited with its Retry-After, and a refused key is auth', async () => {
    const before = Date.now()
    const { client } = fakeClient()
    const failing = (error: Error): FakeClient => ({
      ...client,
      create: () => Promise.reject(error),
      get: () => Promise.reject(error),
    })
    const error = await adapter(
      failing(
        new DaytonaRateLimitError(
          'ThrottlerException: Too Many Requests',
          429,
          new Map([['retry-after', '3']]),
        ),
      ),
    )
      .create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
      .catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.deepEqual([error.kind, error.retryable], ['rate-limited', true])
    assert.equal(error.detail, '429 ThrottlerException: Too Many Requests')
    assert.ok((error.retryAt ?? 0) >= before + 3000)
    const auth = await adapter(
      failing(new DaytonaAuthenticationError('Invalid API key', 401, undefined, 'unauthorized')),
    )
      .get('d1')
      .catch((e: unknown) => e)
    assert.ok(auth instanceof VmApiError)
    assert.deepEqual([auth.kind, auth.code], ['auth', 'unauthorized'])
    const offline = await adapter(failing(new DaytonaConnectionError('connect ECONNREFUSED')))
      .get('d1')
      .catch((e: unknown) => e)
    assert.ok(offline instanceof VmApiError)
    assert.deepEqual([offline.kind, offline.status], ['network', 0])
    const invalid = await adapter(failing(new DaytonaValidationError('name is required')))
      .get('d1')
      .catch((e: unknown) => e)
    assert.ok(invalid instanceof VmApiError)
    assert.deepEqual([invalid.kind, invalid.retryable], ['unknown', false])
    assert.equal(
      (await adapter(failing(new Error('not the SDK')))
        .get('d1')
        .catch((e: unknown) => e)) instanceof VmApiError,
      false,
    )
  })

  test('a create whose start wait ran out deletes the sandbox it made', async () => {
    const { client, calls } = fakeClient({ late: {} })
    const timedOut = Object.assign(new DaytonaTimeoutError('Sandbox failed to start in time'), {
      sandboxId: 'late',
    })
    const error = await adapter({ ...client, create: () => Promise.reject(timedOut) })
      .create({ name: 'n', size: 'small', labels: {}, ttlSeconds: 60 })
      .catch((e: unknown) => e)
    assert.ok(error instanceof VmApiError)
    assert.equal(error.retryable, false)
    assert.deepEqual(calls.slice(-2), [
      ['get', 'late'],
      ['delete', 'late'],
    ])
  })
})

describe('daytonaSshTarget', () => {
  test("reads the user, host and port from Daytona's ssh command", () => {
    assert.deepEqual(daytonaSshTarget('ssh tok@ssh.app.daytona.io'), {
      user: 'tok',
      host: 'ssh.app.daytona.io',
      port: 22,
    })
    assert.deepEqual(daytonaSshTarget('ssh -p2200 -o StrictHostKeyChecking=no tok@h'), {
      user: 'tok',
      host: 'h',
      port: 2200,
    })
    assert.equal(daytonaSshTarget('scp tok@h'), null)
    assert.equal(daytonaSshTarget('ssh h'), null)
  })
})
