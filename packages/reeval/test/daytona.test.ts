// daytona() without Docker or a key: preflight's check of the organization, a run's cleanup by
// labels, the pool's starts and an attempt's lifecycle, all against the fake Daytona API
// (support/daytona.ts) through the real SDK.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  checkDaytona,
  type DaytonaClient,
  DaytonaRateLimited,
  daytonaCapacity,
  daytonaClient,
  daytonaPoolProvider,
  removeRunSandboxes,
  runLabels,
  sshTarget,
  whileLimited,
} from '../src/sandbox/daytona.ts'
import { createDaytona, daytona } from '../src/sandbox-daytona.ts'
import { project, readRun, runCli } from './helpers.ts'
import { unreachableMachines } from './support/boat.ts'
import { type FakeDaytona, fakeDaytona } from './support/daytona.ts'

let api: FakeDaytona
before(async () => {
  api = await fakeDaytona(unreachableMachines)
})
after(() => api.close())

/** Runs `body` with this process's environment pointed at the fake API under `key`. */
async function pointedAt<T>(key: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.DAYTONA_API_URL, key: process.env.DAYTONA_API_KEY }
  process.env.DAYTONA_API_URL = api.url
  if (key === undefined) delete process.env.DAYTONA_API_KEY
  else process.env.DAYTONA_API_KEY = key
  try {
    return await body()
  } finally {
    for (const [name, value] of [
      ['DAYTONA_API_URL', saved.url],
      ['DAYTONA_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** Creates a sandbox on the fake API as Daytona's own client would. */
const create = (name: string, labels: Record<string, string>) =>
  fetch(`${api.url}/sandbox`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, snapshot: 'daytona-small', labels }),
  })

describe("Daytona's SSH command", () => {
  test('gives the token as the user, and the host and port', () => {
    assert.deepEqual(sshTarget('ssh abc123@ssh.app.daytona.io'), {
      user: 'abc123',
      host: 'ssh.app.daytona.io',
      port: 22,
    })
    assert.deepEqual(sshTarget('ssh -p 2222 tok@127.0.0.1'), {
      user: 'tok',
      host: '127.0.0.1',
      port: 2222,
    })
    assert.deepEqual(sshTarget('ssh -o StrictHostKeyChecking=no -p2200 t@h'), {
      user: 't',
      host: 'h',
      port: 2200,
    })
  })

  test('is refused when it names no user or host', () => {
    assert.equal(sshTarget('ssh ssh.app.daytona.io'), null)
    assert.equal(sshTarget('mosh tok@h'), null)
    assert.equal(sshTarget('ssh -p x tok@h'), null)
  })
})

describe("preflight's check of the organization", () => {
  test('passes with the key', async () => {
    await pointedAt(api.key, () => checkDaytona(daytona(), process.cwd()))
  })

  test('names the variable when the key is unset', async () => {
    await assert.rejects(
      pointedAt(undefined, () => checkDaytona(daytona(), process.cwd())),
      { message: /daytona\(\) needs a Daytona API key in DAYTONA_API_KEY, which isn't set/ },
    )
  })

  test('says Daytona refused the key, without printing it', async () => {
    const wrong = 'dtn_wrong_key_0123456789'
    const error = await pointedAt(wrong, () => checkDaytona(daytona(), process.cwd())).catch(
      (e) => e,
    )
    assert.match(String(error.message), /Daytona refused the API key in DAYTONA_API_KEY/)
    assert.doesNotMatch(String(error.message), new RegExp(wrong))
  })
})

describe("a run's cleanup", () => {
  test("deletes the run's sandboxes by its labels, and nobody else's", async () => {
    const team = createDaytona({ prefix: 'team' })()
    for (const [name, labels] of [
      ['mine-1', runLabels(daytona(), 'run-a')],
      ['mine-2', runLabels(daytona(), 'run-a')],
      ['theirs', runLabels(daytona(), 'run-b')],
      ['team', runLabels(team, 'run-a')],
    ] as const) {
      assert.equal((await create(name, labels)).status, 200)
    }
    await pointedAt(api.key, () =>
      removeRunSandboxes('run-a', [daytona(), daytona({ size: 'small' })]),
    )
    assert.deepEqual(api.live().sort(), ['team', 'theirs'])
    await pointedAt(api.key, () => removeRunSandboxes('run-b', [daytona()]))
    await pointedAt(api.key, () => removeRunSandboxes('run-a', [team]))
    assert.deepEqual(api.live(), [])
  })
})

describe("the pool's starts", () => {
  const client = () => pointedAt(api.key, () => daytonaClient(daytona()))

  test('turn a 429 into a rate limit with its Retry-After', async () => {
    const provider = daytonaPoolProvider(daytona(), await client(), 'run-429')
    api.refuseStarts(1, { retryAfterSeconds: 7 })
    const error = await provider.start(new AbortController().signal, 600).catch((e) => e)
    assert.ok(error instanceof DaytonaRateLimited, String(error))
    assert.deepEqual(provider.rateLimited(error), { retryAfterMs: 7000 })
    assert.equal(provider.rateLimited(new Error('other')), null)
  })

  test('create a labeled sandbox that never stops on its own, and delete it when SSH fails', async () => {
    const before = api.created().length
    const provider = daytonaPoolProvider(
      daytona({ size: 'large' }),
      (await client()) as DaytonaClient,
      'run-x',
    )
    await assert.rejects(provider.start(new AbortController().signal, 1800), {
      message: /Daytona's SSH gateway at 127\.0\.0\.1:1 gave no host key/,
    })
    const [made] = api.created().slice(before)
    assert.equal(made?.snapshot, 'daytona-large')
    assert.deepEqual(made?.labels, {
      ...runLabels(daytona(), 'run-x'),
      'code-toolbox-language': 'python',
    })
    assert.equal(made?.ttlMinutes, 30)
    const body = api.requests.findLast((q) => q.call === 'POST /sandbox')?.body
    assert.equal(body?.autoStopInterval, 0, "Daytona's idle stop would cut an attempt off")
    assert.equal(body?.autoDeleteInterval, 0, 'a stopped sandbox is deleted, not kept')
    assert.deepEqual(api.live(), [])
  })
})

describe('a 429 after the start', () => {
  const client = () => pointedAt(api.key, () => daytonaClient(daytona()))

  test('on SSH access, waits for its Retry-After and keeps the sandbox', async () => {
    const provider = daytonaPoolProvider(daytona(), await client(), 'run-ssh-429')
    api.requests.length = 0
    api.refuseCalls(1, /^POST \/sandbox\/[\w-]+\/ssh-access$/, { retryAfterSeconds: 0 })
    // The fake's machines have no SSH server, so the start gets as far as the host key.
    await assert.rejects(provider.start(new AbortController().signal, 600), {
      message: /gave no host key/,
    })
    const asked = api.requests.filter((q) => /\/ssh-access$/.test(q.call))
    assert.deepEqual(
      asked.map((q) => Boolean(q.refused)),
      [true, false],
    )
    assert.equal(api.requests.filter((q) => q.call === 'POST /sandbox').length, 1)
  })

  test('on the TTL, waits and keeps the machine alive', async () => {
    const made = await create('kept', runLabels(daytona(), 'run-ttl'))
    const { id } = (await made.json()) as { id: string }
    const provider = daytonaPoolProvider(daytona(), await client(), 'run-ttl')
    api.requests.length = 0
    api.refuseCalls(2, /^POST \/sandbox\/[\w-]+\/ttl\/\d+$/, { retryAfterSeconds: 0 })
    await provider.keepAlive?.(id, 1200)
    assert.deepEqual(
      api.requests.filter((q) => /\/ttl\//.test(q.call)).map((q) => Boolean(q.refused)),
      [true, true, false],
    )
    assert.ok(api.live().includes('kept'))
    await pointedAt(api.key, () => removeRunSandboxes('run-ttl', [daytona()]))
  })

  test('past the wait, is the rate limit', async () => {
    let calls = 0
    const refused = Object.assign(new Error('Too Many Requests'), {
      statusCode: 429,
      headers: { 'retry-after': '1' },
    })
    await assert.rejects(
      whileLimited(
        'calls',
        async () => {
          calls++
          throw refused
        },
        undefined,
        { maxRateWaitMs: 1500, backoffMs: 10, maxBackoffMs: 10 },
      ),
      DaytonaRateLimited,
    )
    assert.equal(calls, 2)
  })
})

describe('a cancel during the start', () => {
  test('stops waiting on the create, and deletes the sandbox it makes', async () => {
    const slow = await fakeDaytona(
      (name) =>
        new Promise((resolve) => setTimeout(() => resolve(unreachableMachines(name)), 3000)),
    )
    const saved = { url: process.env.DAYTONA_API_URL, key: process.env.DAYTONA_API_KEY }
    process.env.DAYTONA_API_URL = slow.url
    process.env.DAYTONA_API_KEY = slow.key
    try {
      const provider = daytonaPoolProvider(daytona(), await daytonaClient(daytona()), 'run-cut')
      const cut = new AbortController()
      const startedAt = Date.now()
      setTimeout(() => cut.abort(new Error('canceled')), 300)
      await assert.rejects(provider.start(cut.signal, 600), { message: 'canceled' })
      assert.ok(Date.now() - startedAt < 2000, 'the start gave up before the sandbox came up')
      for (let i = 0; i < 100 && slow.live().length; i++)
        await new Promise((r) => setTimeout(r, 100))
      assert.deepEqual(slow.live(), [], 'the sandbox that came up late is deleted')
    } finally {
      for (const [name, value] of [
        ['DAYTONA_API_URL', saved.url],
        ['DAYTONA_API_KEY', saved.key],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await slow.close()
    }
  })
})

describe("the organization's capacity", () => {
  test("is maxConcurrent's, and unknown without it", async () => {
    assert.equal(await daytonaCapacity(daytona()), null)
    assert.deepEqual(await daytonaCapacity(daytona({ maxConcurrent: 5, attemptsPerMachine: 2 })), {
      machines: 3,
      attempts: 5,
    })
  })
})

describe('an attempt on a sandbox it cannot reach', () => {
  const files = {
    'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { daytona } from 'reeval/sandbox/daytona'
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  sandbox: daytona(),
  egress: 'allow-all',
})
`,
    'evals/a.eval.ts': `
import { evaluate } from 'reeval'
evaluate('reaches', async (c) => {
  await c.exec('true')
})
`,
  }

  test('fails as infra, and its sandbox is deleted', async () => {
    const p = await project('daytona-unreachable', files)
    api.requests.length = 0
    const r = await runCli(p.dir, ['run'], {
      env: { DAYTONA_API_URL: api.url, DAYTONA_API_KEY: api.key },
      timeoutMs: 90_000,
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    const { evals } = readRun(p.dir)
    assert.equal(evals[0]?.error?.kind, 'infra', JSON.stringify(evals[0]?.error))
    assert.match(r.stdout + r.stderr, /Daytona's SSH gateway at 127\.0\.0\.1:1 gave no host key/)
    assert.deepEqual(api.live(), [])
    const created = api.requests.find((q) => q.call === 'POST /sandbox')
    assert.match(String(created?.body?.name), /^reeval-[0-9a-f]{8}-[0-9a-f]{6}$/)
    assert.ok(api.requests.some((q) => /^POST \/sandbox\/[\w-]+\/ssh-access$/.test(q.call)))
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(api.key))
  })

  test('stops the run with exit 2 naming the variable when the key is unset', async () => {
    const p = await project('daytona-no-key', files)
    const r = await runCli(p.dir, ['run'], { env: { DAYTONA_API_URL: api.url } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /DAYTONA_API_KEY/)
  })
})
