import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { ApiError, ReevalClient } from '../src/index.ts'
import { fakePlatform } from './fake-platform.ts'

const TOKEN = 'tok_test_never_printed'

const closers: Array<() => Promise<void>> = []
after(() => Promise.all(closers.map((c) => c())))

type Handler = Parameters<typeof fakePlatform>[0]

async function platform(handler: Handler) {
  const p = await fakePlatform(handler)
  closers.push(p.close)
  return p
}

/** A client of `url` that records its waits instead of sleeping. */
function client(url: string, extra: Partial<ConstructorParameters<typeof ReevalClient>[0]> = {}) {
  const waits: number[] = []
  const api = new ReevalClient({
    baseUrl: url,
    auth: () => TOKEN,
    sleep: async (ms) => {
      waits.push(ms)
    },
    random: () => 1,
    ...extra,
  })
  return { api, waits }
}

const rejectsWith = async (p: Promise<unknown>, check: (e: ApiError) => void) => {
  const error = await p.then(
    () => assert.fail('expected the call to fail'),
    (e: unknown) => e,
  )
  assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`)
  check(error)
  for (const text of [error.message, JSON.stringify(error), String(error.cause ?? '')]) {
    assert.ok(!text.includes(TOKEN), `the token is in the error: ${text}`)
  }
  return error
}

describe('paths and auth', () => {
  test('encodes each segment, sends the token and parses the answer', async () => {
    const p = await platform(() => ({
      json: { secrets: [{ name: 'A', mode: 'brokered', version: 1, extra: true }] },
    }))
    const { api } = client(p.url)
    const secrets = await api.secrets.list({ org: 'o/1', project: 'p 2' })
    assert.deepEqual(secrets, [{ name: 'A', mode: 'brokered', version: 1, extra: true }])
    assert.equal(p.seen[0]?.path, '/api/orgs/o%2F1/projects/p%202/secrets')
    assert.equal(p.seen[0]?.authorization, `Bearer ${TOKEN}`)
    assert.equal(p.seen[0]?.headers.accept, 'application/json')
  })

  test("prefixes every route with the base URL's path", async () => {
    const p = await platform(() => ({ json: { orgs: [] } }))
    const { api } = client(`${p.url}/under/here`)
    await api.orgs.list()
    assert.equal(p.seen[0]?.path, '/under/here/api/orgs')
  })

  test('refuses an empty segment before any request', async () => {
    const p = await platform(() => ({ json: {} }))
    const { api } = client(p.url)
    assert.throws(() => api.runs.eventsUrl({ run: '' }), /segment 2 .* is empty/)
    await assert.rejects(api.secrets.list({ org: 'o', project: '' }), TypeError)
    assert.equal(p.seen.length, 0)
  })

  test('sends no Authorization without a token, and reads the token for every request', async () => {
    const p = await platform(() => ({ json: { orgs: [] } }))
    const tokens = [null, 'one', 'two']
    const api = new ReevalClient({ baseUrl: p.url, auth: async () => tokens.shift() })
    await api.orgs.list()
    await api.orgs.list()
    await api.orgs.list()
    assert.deepEqual(
      p.seen.map((s) => s.authorization),
      [undefined, 'Bearer one', 'Bearer two'],
    )
    assert.deepEqual(await new ReevalClient({ baseUrl: p.url }).authHeaders(), {})
  })

  test("the device sign-in sends no token, and sign-out sends the platform's origin", async () => {
    const p = await platform((s) =>
      s.path.endsWith('/code')
        ? { json: { device_code: 'd', user_code: 'U-1', verification_uri: `${p.url}/device` } }
        : s.path.endsWith('/token')
          ? { status: 400, json: { error: 'authorization_pending', error_description: 'Not yet.' } }
          : { status: 401, json: {} },
    )
    const { api } = client(p.url)
    assert.equal((await api.auth.deviceCode({ clientId: 'reeval-cli' })).user_code, 'U-1')
    await rejectsWith(api.auth.deviceToken({ clientId: 'reeval-cli', deviceCode: 'd' }), (e) => {
      assert.equal(e.kind, 'refused')
      assert.equal(e.code, 'authorization_pending')
      assert.equal(e.said, 'Not yet.')
    })
    await api.auth.signOut()
    assert.deepEqual(
      p.seen.map((s) => [s.path, s.authorization]),
      [
        ['/api/auth/device/code', undefined],
        ['/api/auth/device/token', undefined],
        ['/api/auth/sign-out', `Bearer ${TOKEN}`],
      ],
    )
    assert.equal(p.seen[2]?.headers.origin, p.url)
    assert.deepEqual(JSON.parse(p.seen[1]?.body ?? ''), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'd',
      client_id: 'reeval-cli',
    })
  })

  test('refuses a base URL that is not http(s) or carries credentials', () => {
    assert.throws(() => new ReevalClient({ baseUrl: 'ftp://x' }), /http or https/)
    assert.throws(() => new ReevalClient({ baseUrl: 'https://u:p@x' }), /user name or password/)
  })
})

describe('routes', () => {
  test('each call reaches its route with its body', async () => {
    const p = await platform((s) => {
      const key = `${s.method} ${s.path}`
      if (key.endsWith('/secret-names')) return { json: { names: ['A'] } }
      if (s.method === 'PUT' && s.path.includes('/secrets/')) {
        return { status: 201, json: { secret: { name: 'A', mode: 'sandbox', version: 1 } } }
      }
      if (s.method === 'PUT' && s.path.includes('/providers/')) {
        return { json: { provider: { provider: 'openai', projectId: 'p', version: 2 } } }
      }
      if (s.method === 'POST' && s.path.endsWith('/runs')) {
        return {
          status: 201,
          json: { runId: 'r1', status: 'created', upload: { url: `${p.url}/api/runs/r1/bundle` } },
        }
      }
      if (s.method === 'GET' && s.path === '/api/runs/r1') {
        return { json: { id: 'r1', status: 'running', exitCode: null } }
      }
      if (s.path.endsWith('/studio/runs/r1')) {
        return s.method === 'GET'
          ? {
              status: 404,
              json: { error: { code: 'not_found', message: 'No run.', retryable: false } },
            }
          : { json: { revision: 1, status: 'pending' } }
      }
      if (s.path.endsWith('/studio/shares') && s.method === 'GET') return { json: { shares: [] } }
      if (s.path.endsWith('/files.tar.gz')) return { status: 404, json: {} }
      return { status: 204 }
    })
    const { api } = client(p.url)
    const at = { org: 'o', project: 'p' }
    assert.deepEqual(await api.secrets.names({ ...at, reserved: ['A', 'B'] }), {
      names: ['A'],
      reserved: [],
    })
    assert.equal(
      (await api.secrets.set({ ...at, name: 'A', value: 'v', mode: 'sandbox' })).created,
      true,
    )
    await api.secrets.delete({ ...at, name: 'A' })
    const set = await api.providers.set({ org: 'o', provider: 'openai', key: 'k', project: 'p' })
    assert.equal(set.created, false)
    await api.providers.delete({ org: 'o', provider: 'openai', project: 'p' })
    const created = await api.runs.create({ ...at, bundleSha256: 'a'.repeat(64), bundleBytes: 3 })
    assert.equal(created.upload.method, 'PUT')
    await api.runs.uploadBundle({ upload: created.upload, bundle: new Uint8Array([1, 2, 3]) })
    await api.runs.start({ run: 'r1' })
    assert.equal((await api.runs.get({ run: 'r1' })).status, 'running')
    await api.runs.cancel({ run: 'r1' })
    assert.equal(await api.runs.files({ run: 'r1' }), null)
    assert.equal(await api.studio.runs.get({ ...at, run: 'r1' }), null)
    const state = await api.studio.runs.put({ ...at, run: 'r1', archive: new Uint8Array([9]) })
    assert.equal(state.status, 'pending')
    assert.deepEqual(await api.studio.shares.list({ ...at, run: 'r1' }), [])
    await api.studio.shares.revoke({ ...at, id: 'sh_1' })
    await api.studio.analysis.put({ run: 'r1', analysis: new TextEncoder().encode('{}') })
    assert.equal(api.runs.eventsUrl({ run: 'r1' }).href, `${p.url}/api/runs/r1/events`)
    assert.deepEqual(
      p.seen.map(
        (s) =>
          `${s.method} ${s.path}${Object.keys(s.query).length ? `?${new URLSearchParams(s.query)}` : ''}`,
      ),
      [
        'GET /api/orgs/o/projects/p/secret-names?reserved=A%2CB',
        'PUT /api/orgs/o/projects/p/secrets/A',
        'DELETE /api/orgs/o/projects/p/secrets/A',
        'PUT /api/orgs/o/providers/openai',
        'DELETE /api/orgs/o/providers/openai?projectId=p',
        'POST /api/orgs/o/projects/p/runs',
        'PUT /api/runs/r1/bundle',
        'POST /api/runs/r1/start',
        'GET /api/runs/r1',
        'POST /api/runs/r1/cancel',
        'GET /api/runs/r1/artifacts/files.tar.gz',
        'GET /api/orgs/o/projects/p/studio/runs/r1',
        'PUT /api/orgs/o/projects/p/studio/runs/r1',
        'GET /api/orgs/o/projects/p/studio/shares?runId=r1',
        'DELETE /api/orgs/o/projects/p/studio/shares/sh_1',
        'PUT /api/v1/runs/r1/analysis',
      ],
    )
    assert.deepEqual(JSON.parse(p.seen[1]?.body ?? ''), { value: 'v', mode: 'sandbox' })
    assert.deepEqual(JSON.parse(p.seen[3]?.body ?? ''), { key: 'k', projectId: 'p' })
    assert.equal(p.seen[6]?.contentType, 'application/gzip')
    assert.equal(p.seen[12]?.contentType, 'application/zip')
  })

  test('sends the token with an upload only to its own origin', async () => {
    const own = await platform(() => ({ status: 200 }))
    const other = await platform(() => ({ status: 200 }))
    const { api } = client(own.url)
    const bundle = new Uint8Array([1])
    await api.runs.uploadBundle({ upload: { url: `${own.url}/up`, method: 'PUT' }, bundle })
    await api.runs.uploadBundle({ upload: { url: `${other.url}/up?sig=x`, method: 'PUT' }, bundle })
    assert.equal(own.seen[0]?.authorization, `Bearer ${TOKEN}`)
    assert.equal(other.seen[0]?.authorization, undefined)
    await assert.rejects(
      api.runs.uploadBundle({ upload: { url: 'file:///etc/passwd', method: 'PUT' }, bundle }),
      /http or https/,
    )
  })
})

describe('errors', () => {
  test("a refusal carries the platform's code and words, without control characters", async () => {
    const p = await platform(() => ({
      status: 403,
      json: { error: { code: 'forbidden', message: 'Not a member.\u001b[31m', retryable: false } },
    }))
    const { api } = client(p.url)
    await rejectsWith(api.orgs.list(), (e) => {
      assert.equal(e.kind, 'refused')
      assert.equal(e.operation, 'orgs.list')
      assert.equal(e.status, 403)
      assert.equal(e.code, 'forbidden')
      assert.equal(e.said, 'Not a member.[31m')
      assert.equal(e.message, 'GET /api/orgs: Not a member.[31m')
    })
    assert.equal(p.seen.length, 1)
  })

  test('a 5xx without a body is failed, named by its status', async () => {
    const p = await platform(() => ({ status: 502, text: 'bad gateway' }))
    const { api } = client(p.url, { retry: { attempts: 1 } })
    await rejectsWith(api.orgs.list(), (e) => {
      assert.equal(e.kind, 'failed')
      assert.equal(e.message, 'GET /api/orgs: HTTP 502')
    })
  })

  test("an answer that isn't the route's shape is malformed", async () => {
    const p = await platform(() => ({ json: { orgs: [{ id: 1 }] } }))
    const { api } = client(p.url)
    await rejectsWith(api.orgs.list(), (e) => {
      assert.equal(e.kind, 'malformed')
      assert.match(e.message, /orgs\.0\.id/)
    })
  })

  test('never follows a redirect, nor retries one', async () => {
    const target = await platform(() => ({ json: { orgs: [] } }))
    const p = await platform(() => ({
      status: 307,
      headers: { location: `${target.url}/api/orgs` },
    }))
    const { api } = client(p.url)
    await rejectsWith(api.orgs.list(), (e) => {
      assert.equal(e.kind, 'redirected')
      assert.equal(e.status, 307)
    })
    assert.equal(p.seen.length, 1)
    assert.equal(target.seen.length, 0)
  })

  test('no answer is unreachable', async () => {
    const p = await platform(() => ({}))
    await p.close()
    const { api, waits } = client(p.url)
    await rejectsWith(api.orgs.list(), (e) => {
      assert.equal(e.kind, 'unreachable')
      assert.equal(e.status, null)
    })
    assert.equal(waits.length, 2, 'a GET tries 3 times')
  })

  test('an attempt past its deadline is unreachable', async () => {
    const p = await platform(() => 'hang')
    const { api } = client(p.url)
    await rejectsWith(api.orgs.list({ timeoutMs: 50, retry: false }), (e) => {
      assert.equal(e.kind, 'unreachable')
    })
  })
})

describe('retries', () => {
  const flaky = (
    failures: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>,
  ) => platform(() => failures.shift() ?? { json: { orgs: [] } })

  test('a GET retries a 5xx, backing off', async () => {
    const p = await flaky([{ status: 503 }, { status: 500 }])
    const { api, waits } = client(p.url)
    assert.deepEqual(await api.orgs.list(), [])
    assert.equal(p.seen.length, 3)
    assert.deepEqual(waits, [250, 500])
  })

  test('honors Retry-After, and gives up on one past the longest wait', async () => {
    const p = await flaky([{ status: 429, headers: { 'retry-after': '2' } }])
    const { api, waits } = client(p.url)
    await api.orgs.list()
    assert.deepEqual(waits, [2000])
    const q = await flaky([{ status: 429, headers: { 'retry-after': '120' } }])
    const later = client(q.url)
    await rejectsWith(later.api.orgs.list(), (e) => assert.equal(e.retryAfterMs, 120_000))
    assert.deepEqual(later.waits, [])
  })

  test('retries a refusal the platform marks retryable, but not another', async () => {
    const p = await flaky([
      { status: 409, json: { error: { code: 'not_ready', message: 'Soon.', retryable: true } } },
    ])
    const { api } = client(p.url)
    await api.orgs.list()
    assert.equal(p.seen.length, 2)
    const q = await flaky([{ status: 409, json: { error: { code: 'conflict', message: 'No.' } } }])
    await rejectsWith(client(q.url).api.orgs.list(), (e) => assert.equal(e.code, 'conflict'))
    assert.equal(q.seen.length, 1)
  })

  test('a POST tries once unless the call asks for retries', async () => {
    const p = await platform(() => ({ status: 503 }))
    const { api } = client(p.url)
    await rejectsWith(api.runs.start({ run: 'r1' }), (e) => assert.equal(e.kind, 'failed'))
    assert.equal(p.seen.length, 1)
    await rejectsWith(api.runs.start({ run: 'r1' }, { retry: { attempts: 2 } }), () => {})
    assert.equal(p.seen.length, 3)
  })

  test('retry: false tries once', async () => {
    const p = await platform(() => ({ status: 503 }))
    await rejectsWith(client(p.url).api.orgs.list({ retry: false }), () => {})
    assert.equal(p.seen.length, 1)
  })

  test("an abort stops the wait before a retry, with the signal's reason", async () => {
    const p = await platform(() => ({ status: 503 }))
    const controller = new AbortController()
    const api = new ReevalClient({
      baseUrl: p.url,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
          controller.abort(new Error('stopped'))
        }),
    })
    await assert.rejects(api.orgs.list({ signal: controller.signal }), /stopped/)
    assert.equal(p.seen.length, 1)
    await assert.rejects(api.orgs.list({ signal: controller.signal }), /stopped/)
    assert.equal(p.seen.length, 1, 'an aborted signal sends nothing')
  })
})

describe('input refused before sending', () => {
  test('refuses . and .. segments, which would name another route', async () => {
    const p = await platform(() => ({ json: {} }))
    const { api } = client(`${p.url}/base`)
    assert.throws(() => api.runs.eventsUrl({ run: '.' }), /segment 2 .* is "\."/)
    assert.throws(() => api.runs.eventsUrl({ run: '..' }), /is "\.\."/)
    await assert.rejects(api.runs.start({ run: '..' }), TypeError)
    await assert.rejects(api.secrets.delete({ org: 'o', project: '..', name: '..' }), TypeError)
    await assert.rejects(api.providers.delete({ org: '.', provider: 'openai' }), TypeError)
    assert.equal(api.runs.eventsUrl({ run: '...' }).pathname, '/base/api/runs/.../events')
    assert.equal(p.seen.length, 0)
  })

  test('every call rejects on an empty segment, rather than throwing', async () => {
    const { api } = client('http://127.0.0.1:9')
    const calls = [
      () => api.runs.get({ run: '' }),
      () => api.secrets.names({ org: '', project: 'p' }),
      () => api.projects.list({ org: '' }),
      () => api.studio.runs.get({ org: 'o', project: 'p', run: '' }),
    ]
    for (const call of calls) {
      const pending = call()
      assert.ok(pending instanceof Promise)
      await assert.rejects(pending, TypeError)
    }
  })

  test("a token a header can't carry is refused once, naming none of it", async () => {
    const p = await platform(() => ({ json: { orgs: [] } }))
    for (const token of ['secret\ntok_123', 'secret tok_123', 'secret\u0000tok_123', 'tök_123']) {
      const { api, waits } = client(p.url, { auth: () => token })
      for (const pending of [api.orgs.list(), api.authHeaders()]) {
        const error = await pending.then(
          () => assert.fail('expected a refusal'),
          (e: unknown) => e as Error,
        )
        assert.ok(error instanceof TypeError)
        for (const part of ['secret', 'tok_123']) {
          assert.ok(!`${error.message}${String(error.cause ?? '')}`.includes(part))
        }
      }
      assert.deepEqual(waits, [])
    }
    assert.equal(p.seen.length, 0)
  })

  test("refuses a header value a header can't carry", async () => {
    assert.throws(
      () => new ReevalClient({ baseUrl: 'http://x', headers: { 'user-agent': 'a\r\nb' } }),
      /user-agent header's value/,
    )
  })
})

describe('reading the answer', () => {
  test('a GET whose body stalls past the deadline is unreachable, and retried', async () => {
    let n = 0
    const p = await platform(() =>
      n++ === 0 ? { json: { orgs: [] }, stallMs: Infinity } : { json: { orgs: [] } },
    )
    const { api, waits } = client(p.url, { timeoutMs: 50 })
    assert.deepEqual(await api.orgs.list(), [])
    assert.equal(p.seen.length, 2)
    assert.equal(waits.length, 1)
  })

  test('a POST whose body stalls is unreachable, never malformed, and not retried', async () => {
    const p = await platform(() => ({
      json: { runId: 'r1', upload: { url: 'http://x/u' } },
      stallMs: Infinity,
    }))
    const { api } = client(p.url, { timeoutMs: 50 })
    await rejectsWith(
      api.runs.create({ org: 'o', project: 'p', bundleSha256: 'a', bundleBytes: 1 }),
      (e) => {
        assert.equal(e.kind, 'unreachable')
        assert.match(e.message, /cut off \(past the 50 ms deadline\)/)
      },
    )
    assert.equal(p.seen.length, 1)
  })

  test("an abort while the body is read rejects with the signal's reason", async () => {
    const p = await platform(() => ({ json: { orgs: [] }, stallMs: Infinity }))
    const controller = new AbortController()
    const { api } = client(p.url)
    const pending = api.orgs.list({ signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stopped')), 30)
    await assert.rejects(pending, /stopped/)
    assert.equal(p.seen.length, 1)
  })

  test("a download's body isn't held to the deadline", async () => {
    const p = await platform(() => ({ text: 'x'.repeat(64), stallMs: 120 }))
    const { api } = client(p.url, { timeoutMs: 40 })
    const res = await api.runs.files({ run: 'r1' })
    assert.equal((await res?.text())?.length, 64)
  })

  test('a malformed answer keeps no body, and a refusal is one line', async () => {
    const p = await platform((s) =>
      s.path === '/api/me'
        ? { json: { access_token: 'tok_secret', user: null } }
        : {
            status: 400,
            json: { error: { code: 'invalid_request', message: 'line1\nline2\ttab\n' } },
          },
    )
    const { api } = client(p.url)
    await rejectsWith(api.me.get(), (e) => {
      assert.equal(e.kind, 'malformed')
      assert.equal(e.body, null)
      assert.ok(!JSON.stringify(e).includes('tok_secret'))
    })
    await rejectsWith(api.orgs.list(), (e) => assert.equal(e.said, 'line1 line2 tab'))
  })
})

describe('uploads and retried PUTs', () => {
  test('an upload tries once unless the call asks for more', async () => {
    const p = await platform(() => ({ status: 503 }))
    const { api } = client(p.url)
    const at = { org: 'o', project: 'p', run: 'r1', archive: new Uint8Array(8) }
    await rejectsWith(api.studio.runs.put(at), (e) => assert.equal(e.kind, 'failed'))
    assert.equal(p.seen.length, 1)
    await rejectsWith(api.studio.runs.put(at, { retry: { attempts: 2 } }), () => {})
    assert.equal(p.seen.length, 3)
    const upload = { url: `${p.url}/up`, method: 'PUT' }
    await rejectsWith(api.runs.uploadBundle({ upload, bundle: new Uint8Array(8) }), () => {})
    assert.equal(p.seen.length, 4)
  })

  test('a JSON PUT is retried, and reads the answer it ends with', async () => {
    let n = 0
    const p = await platform(() =>
      n++ === 0
        ? { status: 503 }
        : { json: { secret: { name: 'A', mode: 'sandbox', version: 1 } } },
    )
    const { api } = client(p.url)
    const set = await api.secrets.set({ org: 'o', project: 'p', name: 'A', value: 'v' })
    assert.deepEqual(set, { secret: { name: 'A', mode: 'sandbox', version: 1 }, created: false })
    assert.equal(p.seen.length, 2)
  })
})

describe('the other routes', () => {
  test('config, me, projects, providers, a share and a studio run read their answers', async () => {
    const share = {
      id: 'sh_1',
      url: 'http://x/s/sh_1',
      runId: 'r1',
      type: 'report',
      scope: 'team',
      createdAt: '2026-11-13T00:00:00Z',
    }
    const answers: Record<string, { status?: number; json: unknown }> = {
      'GET /api/config': { json: { gatewayBaseUrl: null } },
      'GET /api/me': { json: { user: { id: 'u1', email: 'a@b.c' } } },
      'GET /api/orgs/o/projects': { json: { projects: [{ id: 'p', slug: 'p', name: 'P' }] } },
      'GET /api/orgs/o/providers': {
        json: { providers: [{ provider: 'openai', projectId: null, version: 1 }] },
      },
      'POST /api/orgs/o/projects/p/studio/shares': { status: 201, json: share },
      'GET /api/orgs/o/projects/p/studio/runs/r1': {
        json: { revision: 2, status: 'ready', error: null },
      },
    }
    const p = await platform((s) => answers[`${s.method} ${s.path}`] ?? { status: 404, json: {} })
    const { api } = client(p.url)
    assert.deepEqual(await api.config.get(), { gatewayBaseUrl: null })
    assert.equal((await api.me.get()).email, 'a@b.c')
    assert.equal((await api.projects.list({ org: 'o' }))[0]?.slug, 'p')
    assert.equal((await api.providers.list({ org: 'o' }))[0]?.provider, 'openai')
    const made = await api.studio.shares.create({
      org: 'o',
      project: 'p',
      run: 'r1',
      type: 'report',
      scope: 'team',
    })
    assert.deepEqual(made, { share, created: true })
    assert.deepEqual(JSON.parse(p.seen[4]?.body ?? ''), {
      runId: 'r1',
      type: 'report',
      scope: 'team',
    })
    assert.equal((await api.studio.runs.get({ org: 'o', project: 'p', run: 'r1' }))?.revision, 2)
  })
})
