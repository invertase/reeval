// boat() without Docker or a key: preflight's check of the account, a run's cleanup by name prefix
// and an attempt's lifecycle, all against the fake Boat API (support/boat.ts) through the real SDK.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { type AddressInfo, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { type DockerSession, PNPM_VERSION } from '@reeval/sandbox-docker'
import {
  type BoatClient,
  checkBoat,
  deleteUntilGone,
  firstReachable,
  removeRunSandboxes,
  runPrefix,
  sshRoutes,
} from '../src/sandbox/boat.ts'
import { type HarnessBake, installHarness } from '../src/sandbox/harness-install.ts'
import { boat, createBoat } from '../src/sandbox-boat.ts'
import { project, readRun, runCli, tempDir } from './helpers.ts'
import { type FakeBoat, fakeBoat, NO_ROUTE_IP, unreachableMachines } from './support/boat.ts'
import { SEEDED_RUN_ID, writeStoppedStaging } from './support/resume.ts'

let api: FakeBoat
before(async () => {
  api = await fakeBoat(unreachableMachines, { maxActive: 4 })
})
after(() => api.close())

/** Runs `body` with this process's environment pointed at `url` (the fake API) under `key`. */
async function pointedAt<T>(
  key: string | undefined,
  body: () => Promise<T>,
  url = api.url,
): Promise<T> {
  const saved = { url: process.env.BOAT_BASE_URL, key: process.env.BOAT_API_KEY }
  process.env.BOAT_BASE_URL = url
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
const create = (name: string, on = api) =>
  fetch(`${on.url}/sandboxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${on.key}`, 'content-type': 'application/json' },
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

  test('gives up on an API that never answers', { timeout: 60_000 }, async () => {
    const held: Socket[] = []
    const silent = createServer((socket) => held.push(socket))
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`
    try {
      await pointedAt(api.key, () => removeRunSandboxes('run-a', [boat()]), url)
    } finally {
      for (const socket of held) socket.destroy()
      silent.close()
    }
  })
})

describe("reaching a sandbox's SSH server", () => {
  const servers: Array<{ close(): void }> = []
  after(() => {
    for (const s of servers) s.close()
  })
  /** A port on 127.0.0.1 that greets as sshd does, or accepts and says nothing. */
  async function listen(greets: boolean, port = 0): Promise<number> {
    const sockets: Socket[] = []
    const server = createServer((socket) => {
      sockets.push(socket)
      socket.on('error', () => {})
      if (greets) socket.write('SSH-2.0-OpenSSH_9.6\r\n')
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    servers.push({
      close: () => {
        for (const s of sockets) s.destroy()
        server.close()
      },
    })
    return (server.address() as AddressInfo).port
  }
  /** A port nothing listens on, for now. */
  async function closedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
  }
  const at = (port: number, via: 'machine address' | 'public endpoint') =>
    ({ host: '127.0.0.1', port, via }) as const
  const quick = { probeMs: 500, reachMs: 0 }

  test("tries the machine's own address on port 22 first, then the public endpoint", () => {
    assert.deepEqual(sshRoutes({ machineIp: '2001:db8::24', sshEndpoint: '198.51.100.7:19036' }), [
      { host: '2001:db8::24', port: 22, via: 'machine address' },
      { host: '198.51.100.7', port: 19036, via: 'public endpoint' },
    ])
    assert.deepEqual(sshRoutes({ sshEndpoint: '[2001:db8::7]:2222', machineIp: null }), [
      { host: '2001:db8::7', port: 2222, via: 'public endpoint' },
    ])
    assert.deepEqual(sshRoutes({ machineIp: '198.51.100.9' }), [
      { host: '198.51.100.9', port: 22, via: 'machine address' },
    ])
    assert.deepEqual(sshRoutes({ sshEndpoint: 'no-port' }), [])
  })

  test('takes the machine address when both greet', async () => {
    const routes = [
      at(await listen(true), 'machine address'),
      at(await listen(true), 'public endpoint'),
    ]
    assert.deepEqual(await firstReachable(routes, quick), { route: routes[0] })
  })

  test('falls back to the endpoint when the machine address has no route from here', async () => {
    const endpoint = at(await listen(true), 'public endpoint')
    const started = Date.now()
    const reached = await firstReachable(
      [{ host: NO_ROUTE_IP, port: 22, via: 'machine address' }, endpoint],
      quick,
    )
    assert.deepEqual(reached, { route: endpoint })
    assert.ok(Date.now() - started < 2_000, 'one short probe, at most')
  })

  test('falls back when the machine address takes the connection and never greets', async () => {
    const endpoint = at(await listen(true), 'public endpoint')
    const reached = await firstReachable(
      [at(await listen(false), 'machine address'), endpoint],
      quick,
    )
    assert.deepEqual(reached, { route: endpoint })
  })

  test('waits for a VM whose sshd greets late on the only route this host reaches', async () => {
    const port = await closedPort()
    setTimeout(() => void listen(true, port), 1_200)
    const preferred = at(port, 'machine address')
    const reached = await firstReachable([preferred, at(await listen(false), 'public endpoint')], {
      probeMs: 300,
      reachMs: 10_000,
    })
    assert.deepEqual(reached, { route: preferred })
  })

  test('names every route and why it failed once the VM has had its time', async () => {
    const refused = await closedPort()
    const silent = await listen(false)
    const reached = await firstReachable(
      [at(refused, 'machine address'), at(silent, 'public endpoint')],
      quick,
    )
    assert.deepEqual(reached, {
      why: `127.0.0.1:${refused} (machine address): ECONNREFUSED; 127.0.0.1:${silent} (public endpoint): no SSH greeting in 0.5s`,
    })
  })
})

describe("installing a harness's CLI in a new VM", () => {
  const bake = (pnpm: boolean): HarnessBake => ({
    label: 'x-1',
    kind: 'x',
    name: 'the x CLI',
    pnpm,
    recipe: async () => '',
    install: async (session) => {
      await session.run({ command: 'install-x' })
      return '1.0'
    },
  })
  const recording = (exitCode = 0) => {
    const commands: string[] = []
    const session = {
      async run(o: { command: string }) {
        commands.push(o.command)
        return { exitCode: o.command === 'install-x' ? 0 : exitCode, stdout: '', stderr: 'E404' }
      },
    } as unknown as DockerSession
    return { session, commands }
  }

  test("puts reeval's pinned pnpm in npm's global prefix first, as the session's user", async () => {
    const { session, commands } = recording()
    assert.equal(await installHarness(session, bake(true)), '1.0')
    assert.deepEqual(commands, [
      `npm install --global --no-fund --no-audit pnpm@${PNPM_VERSION} && pnpm --version`,
      'install-x',
    ])
  })

  test('skips pnpm for a bake that asks for none, and stops at a failed pnpm', async () => {
    const none = recording()
    await installHarness(none.session, bake(false))
    assert.deepEqual(none.commands, ['install-x'])
    const failed = recording(1)
    await assert.rejects(installHarness(failed.session, bake(true)), {
      message: `npm install pnpm@${PNPM_VERSION} exited 1: E404`,
    })
    assert.equal(failed.commands.length, 1)
  })
})

describe('deleting a sandbox that never got ready', () => {
  /** A sandbox Boat keeps provisioning through the first `drops` deletes, then removes. */
  function stuck(drops: number, after: 'gone' | string = 'gone') {
    const calls: string[] = []
    let deletes = 0
    const api = {
      async deleteSandbox() {
        calls.push('delete')
        deletes++
        return { ok: true }
      },
      async get() {
        calls.push('get')
        if (deletes <= drops) return { sandbox: { id: 'bx_1', name: 'n', state: 'provisioning' } }
        if (after !== 'gone') return { sandbox: { id: 'bx_1', name: 'n', state: after } }
        throw Object.assign(new Error('gone'), { response: new Response('{}', { status: 404 }) })
      },
    } as unknown as BoatClient
    return { api, calls }
  }
  const quick = { pollMs: 5, redeleteMs: 30 }

  test('sends the delete again until Boat answers 404', async () => {
    const { api, calls } = stuck(2)
    assert.equal(await deleteUntilGone(api, 'bx_1', { ...quick, deadlineMs: 10_000 }), true)
    assert.equal(calls.filter((c) => c === 'delete').length, 3)
    assert.equal(calls.at(-1), 'get')
  })

  for (const state of ['archiving', 'archived', 'error', 'cancelled']) {
    test(`stops once Boat reports it ${state}`, async () => {
      const { api, calls } = stuck(0, state)
      assert.equal(await deleteUntilGone(api, 'bx_1', { ...quick, deadlineMs: 10_000 }), true)
      assert.deepEqual(calls, ['delete', 'get'])
    })
  }

  test('sends one delete and stops when the attempt was canceled', async () => {
    const { api, calls } = stuck(Number.POSITIVE_INFINITY)
    const canceled = new AbortController()
    canceled.abort()
    const signal = canceled.signal
    assert.equal(await deleteUntilGone(api, 'bx_1', { ...quick, signal }), false)
    assert.deepEqual(calls, ['delete'])
  })

  test('stops polling as soon as the attempt is canceled', async () => {
    const { api, calls } = stuck(Number.POSITIVE_INFINITY)
    const canceled = new AbortController()
    const started = Date.now()
    setTimeout(() => canceled.abort(), 50)
    const signal = canceled.signal
    const options = { pollMs: 60_000, redeleteMs: 60_000, signal }
    assert.equal(await deleteUntilGone(api, 'bx_1', options), false)
    assert.ok(Date.now() - started < 5_000, 'it did not wait out the poll')
    assert.deepEqual(calls, ['delete', 'get'])
  })

  test('gives up after its deadline', async () => {
    const { api } = stuck(Number.POSITIVE_INFINITY)
    const started = Date.now()
    assert.equal(await deleteUntilGone(api, 'bx_1', { ...quick, deadlineMs: 100 }), false)
    assert.ok(Date.now() - started < 5_000)
  })
})

describe('--resume of a stopped run', () => {
  // Machines that never start fail the resumed attempt at once, which is all these need of it.
  let down: FakeBoat
  before(async () => {
    down = await fakeBoat(
      async () => {
        throw new Error('no machine')
      },
      { maxActive: 4 },
    )
  })
  after(() => down.close())

  const evalFile = (options: string) => `
import { evaluate } from 'reeval'
import { createBoat } from 'reeval/sandbox/boat'
evaluate('reaches', ${options}async (c) => {
  await c.exec('true')
})
`
  const config = (sandbox: string) => `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { boat } from 'reeval/sandbox/boat'
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  ${sandbox}
  egress: 'allow-all',
})
`

  /**
   * Resumes a stopped run that left a VM named `left` on the fake API: the calls the resume
   * made, and where among them it deleted that VM.
   */
  async function resume(name: string, files: Record<string, string>, left: string) {
    const p = await project(name, files)
    writeStoppedStaging(p.dir, SEEDED_RUN_ID)
    const made = await create(left, down)
    assert.equal(made.status, 201)
    const { sandbox } = (await made.json()) as { sandbox: { id: string } }
    down.requests.length = 0
    const r = await runCli(p.dir, ['run', '--resume', SEEDED_RUN_ID], {
      env: { BOAT_BASE_URL: down.url, BOAT_API_KEY: down.key },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.deepEqual(down.live(), [])
    const calls = down.requests.map((q) => q.call)
    const deleted = calls.indexOf(`DELETE /sandboxes/${sandbox.id}`)
    assert.ok(deleted >= 0, calls.join('\n'))
    assert.ok(deleted < calls.indexOf('POST /sandboxes'), calls.join('\n'))
    return { calls, deleted }
  }

  test("deletes the config's Boat VMs it left before reading the account's capacity", async () => {
    const left = `${runPrefix(boat(), SEEDED_RUN_ID)}dead00`
    const { calls, deleted } = await resume(
      'boat-resume-config',
      { 'reeval.config.ts': config('sandbox: boat(),'), 'evals/a.eval.ts': evalFile('') },
      left,
    )
    assert.ok(deleted < calls.indexOf('GET /limits'), calls.join('\n'))
  })

  test("deletes an eval's own Boat VMs it left before any attempt starts", async () => {
    const left = `${runPrefix(createBoat({ prefix: 'own' })(), SEEDED_RUN_ID)}dead00`
    await resume(
      'boat-resume-eval',
      {
        'reeval.config.ts': config(''),
        'evals/a.eval.ts': evalFile(`{ sandbox: createBoat({ prefix: 'own' })() }, `),
      },
      left,
    )
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
    assert.match(
      r.stdout + r.stderr,
      new RegExp(
        `is up, but this host can't reach its SSH server: \\[${NO_ROUTE_IP}\\]:22 \\(machine address\\): [^;]+; 127\\.0\\.0\\.1:1 \\(public endpoint\\): ECONNREFUSED`,
      ),
    )
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

  test('stops the run with exit 2, before any VM, when the host has no OpenSSH', async () => {
    const p = await project('boat-no-ssh', files)
    const bin = tempDir('no-ssh')
    for (const tool of ['git', 'sh']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
      symlinkSync(found.stdout.trim(), join(bin, tool))
    }
    api.requests.length = 0
    const r = await runCli(p.dir, ['run'], {
      env: { BOAT_BASE_URL: api.url, BOAT_API_KEY: api.key, PATH: bin },
    })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /boat\(\) runs every command over SSH, and there's no ssh/)
    assert.ok(!api.requests.some((q) => q.call === 'POST /sandboxes'), 'no VM was started')
  })

  test('stops the run with exit 2 naming the variable when the key is unset', async () => {
    const p = await project('boat-no-key', files)
    const r = await runCli(p.dir, ['run'], { env: { BOAT_BASE_URL: api.url } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /BOAT_API_KEY/)
  })
})
