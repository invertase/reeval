// boat() without Docker or a key: preflight's check of the account, a run's cleanup by name prefix
// and an attempt's lifecycle, all against the fake Boat API (support/boat.ts) through the real SDK.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { checkBoat, removeRunSandboxes, runPrefix } from '../src/sandbox/boat.ts'
import { boat, createBoat } from '../src/sandbox-boat.ts'
import { project, readRun, runCli } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'

let api: FakeBoat
before(async () => {
  api = await fakeBoat(unreachableMachines, { maxActive: 4 })
})
after(() => api.close())

/** Runs `body` with this process's environment pointed at the fake API under `key`. */
async function pointedAt<T>(key: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.BOAT_BASE_URL, key: process.env.BOAT_API_KEY }
  process.env.BOAT_BASE_URL = api.url
  if (key === undefined) delete process.env.BOAT_API_KEY
  else process.env.BOAT_API_KEY = key
  try {
    return await body()
  } finally {
    for (const [name, value] of [
      ['BOAT_BASE_URL', saved.url],
      ['BOAT_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** Creates a sandbox on the fake API as Boat's own client would. */
const create = (name: string) =>
  fetch(`${api.url}/sandboxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, type: 'small' }),
  })

describe("preflight's check of the account", () => {
  test('passes with the key and a machine size the account starts', async () => {
    await pointedAt(api.key, () => checkBoat(boat(), process.cwd()))
  })

  test('names the variable when the key is unset', async () => {
    await assert.rejects(
      pointedAt(undefined, () => checkBoat(boat(), process.cwd())),
      {
        message: /boat\(\) needs a Boat API key in BOAT_API_KEY, which isn't set/,
      },
    )
  })

  test('says Boat refused the key, without printing it', async () => {
    const wrong = 'boat_wrong_key_0123456789'
    const error = await pointedAt(wrong, () => checkBoat(boat(), process.cwd())).catch((e) => e)
    assert.match(
      String(error.message),
      /Boat refused the API key in BOAT_API_KEY: 401 unauthorized/,
    )
    assert.doesNotMatch(String(error.message), new RegExp(wrong))
  })

  test('refuses a machine size the account does not start', async () => {
    await assert.rejects(
      pointedAt(api.key, () => checkBoat(boat({ type: 'large' }), process.cwd())),
      {
        message: /Boat won't start a large machine on this account: not on this plan/,
      },
    )
  })
})

describe("a run's cleanup", () => {
  test("deletes the run's sandboxes under its prefix, and nobody else's", async () => {
    const mine = runPrefix(boat(), 'run-a')
    const theirs = runPrefix(boat(), 'run-b')
    const team = runPrefix(createBoat({ prefix: 'team' })(), 'run-a')
    for (const name of [`${mine}aaaaaa`, `${mine}bbbbbb`, `${theirs}cccccc`, `${team}dddddd`]) {
      assert.equal((await create(name)).status, 201)
    }
    await pointedAt(api.key, () => removeRunSandboxes('run-a', [boat(), boat({ type: 'small' })]))
    assert.deepEqual(api.live().sort(), [`${theirs}cccccc`, `${team}dddddd`].sort())
    await pointedAt(api.key, () => removeRunSandboxes('run-b', [boat()]))
    await pointedAt(api.key, () => removeRunSandboxes('run-a', [createBoat({ prefix: 'team' })()]))
    assert.deepEqual(api.live(), [])
  })
})

describe('an attempt on a sandbox it cannot reach', () => {
  const files = {
    'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { boat } from 'reeval/sandbox/boat'
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  sandbox: boat(),
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
    const p = await project('boat-unreachable', files)
    api.requests.length = 0
    const r = await runCli(p.dir, ['run'], {
      env: { BOAT_BASE_URL: api.url, BOAT_API_KEY: api.key },
      timeoutMs: 90_000,
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    const { evals } = readRun(p.dir)
    assert.equal(evals[0]?.error?.kind, 'infra', JSON.stringify(evals[0]?.error))
    assert.deepEqual(api.live(), [])
    const created = api.requests.find((q) => q.call === 'POST /sandboxes')
    assert.ok(created, api.requests.map((q) => q.call).join('\n'))
    const name = String(created.body?.name)
    assert.match(name, /^reeval-[0-9a-f]{8}-[0-9a-f]{6}$/)
    assert.equal(created.idempotencyKey, name, 'a retried create makes one sandbox')
    assert.equal(created.body?.noEnv, true)
    assert.equal(created.body?.snapshots, false, 'a stopped sandbox is erased, not kept')
    assert.ok(Number(created.body?.ttlSeconds) > 600, 'the TTL outlasts the attempt')
    assert.ok(api.requests.some((q) => /^POST \/sandboxes\/bx_\w+\/sshkey$/.test(q.call)))
    assert.ok(api.requests.some((q) => /^DELETE \/sandboxes\/bx_\w+$/.test(q.call)))
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(api.key))
  })

  test('stops the run with exit 2 naming the variable when the key is unset', async () => {
    const p = await project('boat-no-key', files)
    const r = await runCli(p.dir, ['run'], { env: { BOAT_BASE_URL: api.url } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /BOAT_API_KEY/)
  })
})
