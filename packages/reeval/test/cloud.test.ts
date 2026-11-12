// cloud() without Docker, against a fake VM service (support/vm-service.ts) in front of the fake
// VM API (support/boat.ts), through REEVAL_VM_URL and REEVAL_VM_TOKEN: preflight, the pool's
// limits, refused starts, a run's cleanup and an attempt's lifecycle, and nothing it says names
// the upstream.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { cloud } from '../src/internal-vm.ts'
import { runPrefix } from '../src/sandbox/boat.ts'
import {
  CLOUD_PREFIX,
  checkCloud,
  cloudCapacity,
  openCloudPool,
  removeRunVms,
  VM_TOKEN,
  VM_URL,
} from '../src/sandbox/cloud.ts'
import { project, readRun, runCli } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import {
  type FakeVmLimits,
  type FakeVmService,
  fakeVmService,
  VM_RUN_LABEL,
} from './support/vm-service.ts'

let api: FakeBoat
const services: FakeVmService[] = []
before(async () => {
  api = await fakeBoat(unreachableMachines, { maxActive: 20 })
})
after(async () => {
  await Promise.all(services.map((p) => p.close()))
  await api.close()
})

const service = async (caps: Partial<FakeVmLimits> = {}) => {
  const p = await fakeVmService(api, caps)
  services.push(p)
  return p
}

/** Runs `body` with REEVAL_VM_URL, REEVAL_VM_TOKEN and REEVAL_SANDBOX_LABELS set, less what's undefined. */
async function inRun<T>(
  env: { url?: string; token?: string; labels?: string },
  body: () => Promise<T>,
): Promise<T> {
  const names = [VM_URL, VM_TOKEN, 'REEVAL_SANDBOX_LABELS'] as const
  const saved = names.map((name) => process.env[name])
  names.forEach((name, i) => {
    const value = [env.url, env.token, env.labels][i]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  try {
    return await body()
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]
      else process.env[name] = saved[i]
    })
  }
}

const on = (p: FakeVmService) => ({ url: p.url, token: p.token })

let others = 0
/** Starts a VM through `p` as another of the run's callers would. */
const create = (p: FakeVmService, name = `other-${others++}`, type = 'small') =>
  fetch(`${p.url}/sandboxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, type }),
  })

describe("preflight's check of the run's VM service", () => {
  test('passes with both variables set', async () => {
    const p = await service()
    await inRun(on(p), () => checkCloud(cloud(), process.cwd()))
  })

  test('names the variables that are unset', async () => {
    const p = await service()
    await assert.rejects(
      inRun({}, () => checkCloud(cloud(), process.cwd())),
      {
        message:
          /^cloud\(\) needs REEVAL_VM_URL and REEVAL_VM_TOKEN, and REEVAL_VM_URL and REEVAL_VM_TOKEN aren't set here/,
      },
    )
    await assert.rejects(
      inRun({ url: p.url }, () => checkCloud(cloud(), process.cwd())),
      { message: /, and REEVAL_VM_TOKEN isn't set here/ },
    )
  })

  test('says reeval refused the token, without printing it or the upstream', async () => {
    const p = await service()
    const wrong = 'not_the_token'
    const refused = await inRun({ url: p.url, token: wrong }, () =>
      checkCloud(cloud(), process.cwd()),
    ).catch((e) => e)
    assert.match(
      String(refused.message),
      /^reeval refused the token in REEVAL_VM_TOKEN: 401 unauthorized/,
    )
    assert.doesNotMatch(String(refused.message), new RegExp(`${wrong}|boat`, 'i'))
    p.end()
    await assert.rejects(
      inRun(on(p), () => checkCloud(cloud(), process.cwd())),
      {
        message: /^reeval refused the token in REEVAL_VM_TOKEN: 401 unauthorized/,
      },
    )
  })

  test('refuses a size the service refuses, in its words', async () => {
    const p = await service()
    await assert.rejects(
      inRun(on(p), () => checkCloud(cloud({ size: 'medium' }), process.cwd())),
      {
        message:
          /^reeval won't start a medium machine on this run: A run's VMs may be at most small\./,
      },
    )
    const roomier = await service({ maxType: 'default' })
    await inRun(on(roomier), () => checkCloud(cloud({ size: 'medium' }), process.cwd()))
  })

  test('refuses a run the service says can start nothing more', async () => {
    const p = await service({ maxStarts: 1 })
    assert.equal((await create(p)).status, 201)
    await assert.rejects(
      inRun(on(p), () => checkCloud(cloud(), process.cwd())),
      {
        message: /^reeval won't start sandboxes on this run: The run used its 1 VM starts\./,
      },
    )
  })

  test("refuses the service's reserved labels, naming REEVAL_SANDBOX_LABELS", async () => {
    const p = await service()
    await assert.rejects(
      inRun({ ...on(p), labels: 'team=x,reeval.platform.x=mine' }, () =>
        checkCloud(cloud(), process.cwd()),
      ),
      {
        message:
          /^REEVAL_SANDBOX_LABELS sets reeval\.platform\.x, and keys starting reeval\.platform\. are reeval's own/,
      },
    )
    await assert.rejects(
      inRun({ ...on(p), labels: 'Reeval.Platform.Run=mine' }, () =>
        checkCloud(cloud(), process.cwd()),
      ),
      { message: /^REEVAL_SANDBOX_LABELS sets Reeval\.Platform\.Run, and keys starting/ },
    )
  })

  test('refuses more labels than the service takes, naming REEVAL_SANDBOX_LABELS', async () => {
    const p = await service()
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `team-${i}=x`).join(',')
    await inRun({ ...on(p), labels: labels(14) }, () => checkCloud(cloud(), process.cwd()))
    await assert.rejects(
      inRun({ ...on(p), labels: labels(15) }, () => checkCloud(cloud(), process.cwd())),
      {
        message:
          /^REEVAL_SANDBOX_LABELS sets more than the 14 labels cloud\(\) takes beside reeval's own/,
      },
    )
  })
})

describe("the run's pool", () => {
  test('reads its start and machine limits from the service', async () => {
    const p = await service({ maxStarts: 5, maxLive: 3 })
    assert.equal((await create(p)).status, 201)
    const { options } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-pool', root: process.cwd() }),
    )
    assert.deepEqual(options.limits, {
      machines: 2,
      startsPerMinute: null,
      startsPerHour: null,
      starts: 4,
    })
  })

  test('a 429 for too many VMs at once is a rate limit with no wait named, so the pool backs off', async () => {
    const p = await service({ maxLive: 1 })
    assert.equal((await create(p)).status, 201)
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-busy', root: process.cwd() }),
    )
    const error = await inRun(on(p), () => provider.start(new AbortController().signal, 600)).catch(
      (e: Error) => e,
    )
    assert.deepEqual(provider.rateLimited(error as Error), { retryAfterMs: null })
    assert.match(
      String((error as Error).message),
      /^reeval is limiting starts: 429 rate_limited: A run may have 1 VMs at once\./,
    )
  })

  test('a 403 fails the start in plain words, not as a rate limit', async () => {
    const p = await service({ maxStarts: 1 })
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-spent', root: process.cwd() }),
    )
    assert.equal((await create(p)).status, 201)
    const error = (await inRun(on(p), () =>
      provider.start(new AbortController().signal, 600),
    ).catch((e: Error) => e)) as Error
    assert.equal(provider.rateLimited(error), null)
    assert.match(
      error.message,
      /^reeval won't start another sandbox for this run: 403 forbidden: A run may start 1 VMs\./,
    )
    assert.doesNotMatch(error.message, /boat/i)
  })
})

describe('a run the service ended', () => {
  for (const code of ['run_cancelled', 'run_deadline']) {
    test(`a 409 ${code} stops the start for good, not as infra or a rate limit`, async () => {
      const p = await service()
      const { provider } = await inRun(on(p), () =>
        openCloudPool(cloud(), { runId: `run-${code}`, root: process.cwd() }),
      )
      p.stopRun(code, 'The run starts no more VMs.')
      const error = (await inRun(on(p), () =>
        provider.start(new AbortController().signal, 600),
      ).catch((e: Error) => e)) as Error
      assert.equal(error.name, 'RunStopped')
      assert.equal(provider.rateLimited(error), null)
      assert.equal(
        error.message,
        `reeval ended the run, so it starts no more machines: 409 ${code}: The run starts no more VMs.`,
      )
    })
  }

  test('any other 409 fails the start as infra', async () => {
    const p = await service()
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-conflict', root: process.cwd() }),
    )
    p.stopRun('conflict', 'Something else.')
    const error = (await inRun(on(p), () =>
      provider.start(new AbortController().signal, 600),
    ).catch((e: Error) => e)) as Error
    assert.equal(error.name, 'InfraError')
  })

  test('waits out its refusals with no limit of its own', async () => {
    const p = await service()
    const { options } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-waits', root: process.cwd() }),
    )
    assert.equal(options.maxRateWaitMs, Number.POSITIVE_INFINITY)
  })
})

describe('a token refused mid-run', () => {
  test('fails the start as infra, not as a rate limit', async () => {
    const p = await service()
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-expired', root: process.cwd() }),
    )
    p.end()
    const error = (await inRun(on(p), () =>
      provider.start(new AbortController().signal, 600),
    ).catch((e: Error) => e)) as Error
    assert.equal(error.name, 'InfraError')
    assert.equal(provider.rateLimited(error), null)
    assert.match(
      error.message,
      /^reeval refused the token in REEVAL_VM_TOKEN, which is no longer valid: 401 unauthorized/,
    )
    assert.doesNotMatch(error.message, new RegExp(`${p.token}|boat`, 'i'))
  })
})

describe('a VM granted less time than the attempt needs', () => {
  const start = async (p: FakeVmService, runId: string, timeoutS: number) => {
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId, root: process.cwd() }),
    )
    return (await inRun(on(p), () =>
      provider.start(new AbortController().signal, timeoutS + 600),
    ).catch((e: Error) => e)) as Error
  }
  const tooShort = (granted: number, needs: number) =>
    new RegExp(
      `^reeval gave sandbox bx_\\w+ ${granted}s to live, and the attempt needs ${needs}s, its timeout and setup: the VM service grants no more, so give the eval a shorter timeout$`,
    )

  test('fails the start before the attempt runs, past the time the service grants, and deletes it', async () => {
    const p = await service()
    const error = await start(p, 'run-long', 7200)
    assert.equal(error.name, 'InfraError')
    assert.match(error.message, tooShort(3000, 7200))
    assert.deepEqual(p.live(), [])
  })

  test('fails the start past the run’s own end', async () => {
    const p = await service({ tokenTtl: 900 })
    const error = await start(p, 'run-late', 1200)
    assert.match(
      error.message,
      /^reeval gave sandbox bx_\w+ (899|900)s to live, and the attempt needs 1200s, its timeout and setup/,
    )
    assert.deepEqual(p.live(), [])
  })

  test('fails a reused VM’s keep-alive the same way, so the pool drops it', async () => {
    const p = await service()
    const made = (await (await create(p)).json()) as { sandbox: { id: string } }
    const { provider } = await inRun(on(p), () =>
      openCloudPool(cloud(), { runId: 'run-kept', root: process.cwd() }),
    )
    await inRun(on(p), () => provider.keepAlive?.(made.sandbox.id, 1200 + 600))
    await assert.rejects(
      inRun(on(p), async () => provider.keepAlive?.(made.sandbox.id, 7200 + 600)),
      { message: tooShort(3000, 7200) },
    )
  })
})

describe("the service's layout", () => {
  const LAYOUT = { reuse: true, attemptsPerMachine: 1, machineType: 'small' }
  const open = (p: FakeVmService, o: Parameters<typeof cloud>[0], runId: string) =>
    inRun(on(p), () => openCloudPool(cloud(o), { runId, root: process.cwd() }))

  /** The machine type the pool's first start asks the service for. */
  async function startedType(
    p: FakeVmService,
    provider: Awaited<ReturnType<typeof open>>['provider'],
  ) {
    api.requests.length = 0
    const stop = new AbortController()
    const started = inRun(on(p), () => provider.start(stop.signal, 900)).catch(() => null)
    while (!api.requests.some((q) => q.call === 'POST /sandboxes'))
      await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await started
    return api.requests.find((q) => q.call === 'POST /sandboxes')?.body?.type
  }

  test("lays the pool out as /limits says, not as the eval's options do", async () => {
    const p = await service({ layout: LAYOUT })
    const { provider, options } = await open(
      p,
      { size: 'medium', reuse: false, attemptsPerMachine: 3 },
      'run-laid-out',
    )
    assert.deepEqual([options.attemptsPerMachine, options.reuse], [1, true])
    assert.equal(await startedType(p, provider), 'small')
  })

  test('starts the machine type the layout names', async () => {
    const p = await service({
      maxType: 'default',
      layout: { reuse: false, attemptsPerMachine: 2, machineType: 'default' },
    })
    const { provider, options } = await open(p, {}, 'run-medium')
    assert.deepEqual([options.attemptsPerMachine, options.reuse], [2, false])
    assert.equal(await startedType(p, provider), 'default')
  })

  test("keeps the eval's options when the service names no layout, or one it can't read", async () => {
    for (const layout of [
      undefined,
      null,
      { reuse: 'yes' },
      { ...LAYOUT, attemptsPerMachine: 0 },
    ]) {
      const p = await service({ layout })
      const { options } = await open(p, { reuse: true, attemptsPerMachine: 2 }, 'run-own')
      assert.deepEqual([options.attemptsPerMachine, options.reuse], [2, true], String(layout))
    }
  })

  test("checks and counts the layout's machines, not the eval's", async () => {
    const p = await service({ maxLive: 3, layout: LAYOUT })
    await inRun(on(p), () => checkCloud(cloud({ size: 'medium' }), process.cwd()))
    assert.deepEqual(
      await inRun(on(p), () => cloudCapacity(cloud({ attemptsPerMachine: 2, maxConcurrent: 5 }))),
      { machines: 3, attempts: 3 },
    )
  })

  test('a reused VM the service takes back at its keep-alive is reclaimed, not failed', async () => {
    const p = await service({ layout: LAYOUT })
    const made = (await (await create(p)).json()) as { sandbox: { id: string } }
    const { provider } = await open(p, {}, 'run-reclaimed')
    p.reclaim(1)
    const error = (await inRun(on(p), async () =>
      provider.keepAlive?.(made.sandbox.id, 1200),
    ).catch((e: Error) => e)) as Error
    assert.equal(error.name, 'MachineReclaimed')
    assert.equal(
      error.message,
      `reeval took sandbox ${made.sandbox.id} back: 409 vm_released: The run holds 2 VMs, more than its 1 now.`,
    )
    assert.deepEqual(p.live(), [])
  })
})

describe("a run's cleanup", () => {
  test("deletes the run's VMs, and nobody else's", async () => {
    const p = await service()
    const mine = runPrefix({ prefix: CLOUD_PREFIX }, 'run-a')
    const theirs = runPrefix({ prefix: CLOUD_PREFIX }, 'run-b')
    for (const name of [`${mine}aaaaaa`, `${theirs}bbbbbb`]) {
      assert.equal((await create(p, name)).status, 201)
    }
    await inRun(on(p), () => removeRunVms('run-a'))
    assert.equal(p.live().length, 1)
    await inRun({}, () => removeRunVms('run-b'))
    assert.equal(p.live().length, 1, 'without the variables it finds nothing')
    await inRun(on(p), () => removeRunVms('run-b'))
    assert.deepEqual(p.live(), [])
  })
})

describe("the service's capacity", () => {
  test('is the free machines times attemptsPerMachine, capped by maxConcurrent', async () => {
    const p = await service({ maxLive: 3 })
    const at = (o: Parameters<typeof cloud>[0]) => inRun(on(p), () => cloudCapacity(cloud(o)))
    assert.deepEqual(await at({}), { machines: 3, attempts: 3 })
    assert.deepEqual(await at({ attemptsPerMachine: 2, maxConcurrent: 5 }), {
      machines: 3,
      attempts: 5,
    })
  })
})

describe('an attempt on a VM it cannot reach', () => {
  const files = (size: string) => ({
    'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { cloud } from 'reeval/internal/vm'
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  sandbox: cloud(${size}),
  egress: 'allow-all',
})
`,
    'evals/a.eval.ts': `
import { evaluate } from 'reeval'
evaluate('reaches', async (c) => {
  await c.exec('true')
})
`,
  })

  test('fails as infra, labeled and deleted, and the output never names the upstream', async () => {
    const p = await service({ maxType: 'default' })
    const dir = (await project('cloud-unreachable', files("{ size: 'medium' }"))).dir
    const env = { [VM_URL]: p.url, [VM_TOKEN]: p.token }
    const r = await runCli(dir, ['run'], {
      env: { ...env, REEVAL_SANDBOX_LABELS: 'reeval-job=42' },
      timeoutMs: 90_000,
    })
    assert.equal(r.code, 2, 'reeval- labels are reeval’s own')
    assert.match(r.stdout + r.stderr, /keys starting reeval- are reeval's own/)
    assert.equal(p.starts(), 0, 'no VM was started')

    api.requests.length = 0
    const run = await runCli(dir, ['run'], {
      env: { ...env, REEVAL_SANDBOX_LABELS: 'sweep-job=42' },
      timeoutMs: 90_000,
    })
    const out = run.stdout + run.stderr
    assert.equal(run.code, 3, out)
    const { evals } = readRun(dir)
    assert.equal(evals[0]?.error?.kind, 'infra', JSON.stringify(evals[0]?.error))
    assert.match(out, /reeval sandbox bx_\w+ is up, but this host can't reach its SSH server/)
    assert.doesNotMatch(out, /boat/i)
    assert.doesNotMatch(out, new RegExp(p.token))
    assert.deepEqual(p.live(), [])
    assert.ok(
      p.requests.every((q) => q.status < 400 || (q.status === 404 && q.call.startsWith('GET '))),
      JSON.stringify(p.requests),
    )
    const created = api.requests.find((q) => q.call === 'POST /sandboxes')
    assert.ok(created, api.requests.map((q) => q.call).join('\n'))
    const name = String(created.body?.name)
    assert.match(name, /^reeval-[0-9a-f]{8}-[0-9a-f]{6}$/)
    assert.equal(created.body?.type, 'default', "medium is the service's default machine type")
    assert.ok(Number(created.body?.ttlSeconds) <= 3000, 'the service clamps the TTL')
    assert.deepEqual(created.body?.labels, {
      'sweep-job': '42',
      'reeval-prefix': 'reeval',
      'reeval-run': name.split('-')[1],
      [VM_RUN_LABEL]: p.runId,
    })
  })

  test('waits on refused starts until the service ends the run, then records the attempt canceled', async () => {
    const p = await service({ maxLive: 0 })
    const dir = (await project('cloud-ended', files(''))).dir
    const env = { [VM_URL]: p.url, [VM_TOKEN]: p.token }
    // The service ends the run once it has refused a create, however long the attempt took to ask.
    const stopping = setInterval(() => {
      if (p.requests.some((q) => q.call === 'POST /vm/sandboxes' && q.status === 429)) {
        p.stopRun('run_deadline', 'The run waited past its start deadline.')
        clearInterval(stopping)
      }
    }, 20)
    const run = await runCli(dir, ['run'], { env, timeoutMs: 90_000 }).finally(() =>
      clearInterval(stopping),
    )
    const out = run.stdout + run.stderr
    const { evals } = readRun(dir)
    assert.equal(evals[0]?.error?.kind, 'aborted', JSON.stringify(evals[0]?.error))
    assert.match(String(evals[0]?.error?.message), /409 run_deadline/)
    const creates = p.requests.filter((q) => q.call === 'POST /vm/sandboxes')
    assert.deepEqual(
      [...new Set(creates.map((q) => q.status))],
      [429, 409],
      JSON.stringify(p.requests),
    )
    assert.equal(creates.filter((q) => q.status === 409).length, 1, 'no create after the 409')
    assert.equal(p.starts(), 0)
    assert.doesNotMatch(out, /boat/i)
  })

  test('stops the run with exit 2 without REEVAL_VM_URL and REEVAL_VM_TOKEN, naming both', async () => {
    const p = await service()
    const dir = (await project('cloud-not-cloud', files(''))).dir
    const r = await runCli(dir, ['run'], { env: { [VM_URL]: '', [VM_TOKEN]: '' } })
    const out = r.stdout + r.stderr
    assert.equal(r.code, 2, out)
    assert.match(out, /REEVAL_VM_URL/)
    assert.match(out, /REEVAL_VM_TOKEN/)
    assert.doesNotMatch(out, /boat/i)
    assert.deepEqual(p.requests, [])
  })
})
