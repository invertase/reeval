// hosted() without Docker, against a fake of the platform's VM proxy (support/vm-proxy.ts) in
// front of the fake VM API it forwards (support/boat.ts), through REEVAL_VM_URL and
// REEVAL_VM_TOKEN: preflight's check of the run's caps, the pool's start budget, the proxy's 429
// and 403 at start, a run's cleanup and an attempt's lifecycle, and nothing it says names the
// provider.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runPrefix } from '../src/sandbox/boat.ts'
import {
  checkHosted,
  HOSTED_PREFIX,
  hostedCapacity,
  openHostedPool,
  removeRunVms,
  VM_TOKEN,
  VM_URL,
} from '../src/sandbox/hosted.ts'
import { hosted } from '../src/sandbox-hosted.ts'
import { project, readRun, runCli } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import {
  type FakeVmProxy,
  fakeVmProxy,
  VM_RUN_LABEL,
  type VmProxyCaps,
} from './support/vm-proxy.ts'

let api: FakeBoat
const proxies: FakeVmProxy[] = []
before(async () => {
  api = await fakeBoat(unreachableMachines, { maxActive: 20 })
})
after(async () => {
  await Promise.all(proxies.map((p) => p.close()))
  await api.close()
})

const proxy = async (caps: Partial<VmProxyCaps> = {}) => {
  const p = await fakeVmProxy(api, caps)
  proxies.push(p)
  return p
}

/** Runs `body` with this process's environment set as a hosted run's is, less what's undefined. */
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

const on = (p: FakeVmProxy) => ({ url: p.url, token: p.token })

let others = 0
/** Starts a VM through `p` as another of the run's callers would. */
const create = (p: FakeVmProxy, name = `other-${others++}`, type = 'small') =>
  fetch(`${p.url}/sandboxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, type }),
  })

describe("preflight's check of the run's VM service", () => {
  test('passes inside a hosted run', async () => {
    const p = await proxy()
    await inRun(on(p), () => checkHosted(hosted(), process.cwd()))
  })

  test('says it runs only in a hosted run, naming what is unset', async () => {
    const p = await proxy()
    await assert.rejects(
      inRun({}, () => checkHosted(hosted(), process.cwd())),
      {
        message:
          /^hosted\(\) runs only inside a hosted reeval run, which sets REEVAL_VM_URL and REEVAL_VM_TOKEN, and REEVAL_VM_URL and REEVAL_VM_TOKEN aren't set here/,
      },
    )
    await assert.rejects(
      inRun({ url: p.url }, () => checkHosted(hosted(), process.cwd())),
      { message: /, and REEVAL_VM_TOKEN isn't set here/ },
    )
  })

  test('says reeval refused the token, or the ended run’s, without printing it or the provider', async () => {
    const p = await proxy()
    const wrong = `${p.runId}.not_the_token`
    const refused = await inRun({ url: p.url, token: wrong }, () =>
      checkHosted(hosted(), process.cwd()),
    ).catch((e) => e)
    assert.match(
      String(refused.message),
      /^reeval refused the run's token in REEVAL_VM_TOKEN: 401 unauthorized/,
    )
    assert.doesNotMatch(String(refused.message), new RegExp(`${wrong}|boat`, 'i'))
    p.end()
    await assert.rejects(
      inRun(on(p), () => checkHosted(hosted(), process.cwd())),
      {
        message: /^reeval refused the run's token in REEVAL_VM_TOKEN: 401 unauthorized/,
      },
    )
  })

  test('refuses a size above the run’s cap, in the service’s words', async () => {
    const p = await proxy()
    await assert.rejects(
      inRun(on(p), () => checkHosted(hosted({ size: 'medium' }), process.cwd())),
      {
        message:
          /^reeval won't start a medium machine on this run: A run's VMs may be at most small\./,
      },
    )
    const roomier = await proxy({ maxType: 'default' })
    await inRun(on(roomier), () => checkHosted(hosted({ size: 'medium' }), process.cwd()))
  })

  test('refuses a run that has used its starts', async () => {
    const p = await proxy({ maxStarts: 1 })
    assert.equal((await create(p)).status, 201)
    await assert.rejects(
      inRun(on(p), () => checkHosted(hosted(), process.cwd())),
      {
        message: /^reeval won't start sandboxes on this run: The run used its 1 VM starts\./,
      },
    )
  })

  test("refuses the platform's own labels, naming REEVAL_SANDBOX_LABELS", async () => {
    const p = await proxy()
    await assert.rejects(
      inRun({ ...on(p), labels: 'team=x,reeval.platform.vm-run=mine' }, () =>
        checkHosted(hosted(), process.cwd()),
      ),
      {
        message:
          /^REEVAL_SANDBOX_LABELS sets reeval\.platform\.vm-run, and keys starting reeval\.platform\. are reeval's own/,
      },
    )
    await assert.rejects(
      inRun({ ...on(p), labels: 'Reeval.Platform.Run=mine' }, () =>
        checkHosted(hosted(), process.cwd()),
      ),
      { message: /^REEVAL_SANDBOX_LABELS sets Reeval\.Platform\.Run, and keys starting/ },
    )
  })

  test('refuses more labels than the service takes, naming REEVAL_SANDBOX_LABELS', async () => {
    const p = await proxy()
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `team-${i}=x`).join(',')
    await inRun({ ...on(p), labels: labels(14) }, () => checkHosted(hosted(), process.cwd()))
    await assert.rejects(
      inRun({ ...on(p), labels: labels(15) }, () => checkHosted(hosted(), process.cwd())),
      {
        message:
          /^REEVAL_SANDBOX_LABELS sets more than the 14 labels hosted\(\) takes beside reeval's own/,
      },
    )
  })
})

describe("the run's pool", () => {
  test('spends the run’s start budget, never an hourly one, and has room for the VMs it may run', async () => {
    const p = await proxy({ maxStarts: 5, maxLive: 3 })
    assert.equal((await create(p)).status, 201)
    const { options } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId: 'run-pool', root: process.cwd() }),
    )
    assert.deepEqual(options.limits, {
      machines: 2,
      startsPerMinute: null,
      startsPerHour: null,
      starts: 4,
    })
  })

  test('a 429 for too many VMs at once is a rate limit with no wait named, so the pool backs off', async () => {
    const p = await proxy({ maxLive: 1 })
    assert.equal((await create(p)).status, 201)
    const { provider } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId: 'run-busy', root: process.cwd() }),
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

  test('a 403 for a spent budget fails the start in plain words, not as a rate limit', async () => {
    const p = await proxy({ maxStarts: 1 })
    const { provider } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId: 'run-spent', root: process.cwd() }),
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

describe('a token that expires mid-run', () => {
  test('fails the start as infra, saying the token outlived the run, not as a rate limit', async () => {
    const p = await proxy()
    const { provider } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId: 'run-expired', root: process.cwd() }),
    )
    p.end()
    const error = (await inRun(on(p), () =>
      provider.start(new AbortController().signal, 600),
    ).catch((e: Error) => e)) as Error
    assert.equal(error.name, 'InfraError')
    assert.equal(provider.rateLimited(error), null)
    assert.match(
      error.message,
      /^reeval refused the run's token in REEVAL_VM_TOKEN, which lasts only as long as the run's runner VM: the run has ended or outlived it: 401 unauthorized/,
    )
    assert.doesNotMatch(error.message, new RegExp(`${p.token}|boat`, 'i'))
  })
})

describe('a VM granted less time than the attempt needs', () => {
  const start = async (p: FakeVmProxy, runId: string, timeoutS: number) => {
    const { provider } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId, root: process.cwd() }),
    )
    return (await inRun(on(p), () =>
      provider.start(new AbortController().signal, timeoutS + 600),
    ).catch((e: Error) => e)) as Error
  }
  const tooShort = (granted: number, needs: number) =>
    new RegExp(
      `^reeval gave sandbox bx_\\w+ ${granted}s to live, and the attempt needs ${needs}s, its timeout and setup: a hosted run's VMs live at most an hour, and never past the run's own end, so give the eval a shorter timeout$`,
    )

  test('fails the start before the attempt runs, past the hour a VM may live, and deletes it', async () => {
    const p = await proxy()
    const error = await start(p, 'run-long', 7200)
    assert.equal(error.name, 'InfraError')
    assert.match(error.message, tooShort(3600, 7200))
    assert.deepEqual(p.live(), [])
  })

  test('fails the start past the run’s own end', async () => {
    const p = await proxy({ tokenTtl: 900 })
    const error = await start(p, 'run-late', 1200)
    assert.match(
      error.message,
      /^reeval gave sandbox bx_\w+ (899|900)s to live, and the attempt needs 1200s, its timeout and setup/,
    )
    assert.deepEqual(p.live(), [])
  })

  test('fails a reused VM’s keep-alive the same way, so the pool drops it', async () => {
    const p = await proxy()
    const made = (await (await create(p)).json()) as { sandbox: { id: string } }
    const { provider } = await inRun(on(p), () =>
      openHostedPool(hosted(), { runId: 'run-kept', root: process.cwd() }),
    )
    await inRun(on(p), () => provider.keepAlive?.(made.sandbox.id, 1200 + 600))
    await assert.rejects(
      inRun(on(p), async () => provider.keepAlive?.(made.sandbox.id, 7200 + 600)),
      { message: tooShort(3600, 7200) },
    )
  })
})

describe("a run's cleanup", () => {
  test("deletes the run's VMs, and nobody else's", async () => {
    const p = await proxy()
    const mine = runPrefix({ prefix: HOSTED_PREFIX }, 'run-a')
    const theirs = runPrefix({ prefix: HOSTED_PREFIX }, 'run-b')
    for (const name of [`${mine}aaaaaa`, `${theirs}bbbbbb`]) {
      assert.equal((await create(p, name)).status, 201)
    }
    await inRun(on(p), () => removeRunVms('run-a'))
    assert.equal(p.live().length, 1)
    await inRun({}, () => removeRunVms('run-b'))
    assert.equal(p.live().length, 1, 'outside a hosted run it finds nothing')
    await inRun(on(p), () => removeRunVms('run-b'))
    assert.deepEqual(p.live(), [])
  })
})

describe("the service's capacity", () => {
  test('is the free machines times attemptsPerMachine, capped by maxConcurrent', async () => {
    const p = await proxy({ maxLive: 3 })
    const at = (o: Parameters<typeof hosted>[0]) => inRun(on(p), () => hostedCapacity(hosted(o)))
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
import { hosted } from 'reeval/sandbox/hosted'
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  sandbox: hosted(${size}),
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

  test('fails as infra, labeled and deleted, and the output never names the provider', async () => {
    const p = await proxy({ maxType: 'default' })
    const dir = (await project('hosted-unreachable', files("{ size: 'medium' }"))).dir
    const env = { [VM_URL]: p.url, [VM_TOKEN]: p.token }
    const r = await runCli(dir, ['run'], {
      env: { ...env, REEVAL_SANDBOX_LABELS: 'reeval-platform-run=run_42' },
      timeoutMs: 90_000,
    })
    assert.equal(r.code, 2, 'reeval- labels are reeval’s own')
    assert.match(r.stdout + r.stderr, /keys starting reeval- are reeval's own/)
    assert.equal(p.starts(), 0, 'no VM was started')

    api.requests.length = 0
    const run = await runCli(dir, ['run'], {
      env: { ...env, REEVAL_SANDBOX_LABELS: 'platform-run=run_42' },
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
    assert.ok(Number(created.body?.ttlSeconds) <= 3600, 'the proxy clamps the TTL')
    assert.deepEqual(created.body?.labels, {
      'platform-run': 'run_42',
      'reeval-prefix': 'reeval',
      'reeval-run': name.split('-')[1],
      [VM_RUN_LABEL]: p.runId,
    })
  })

  test('stops the run with exit 2 outside a hosted run, naming both variables', async () => {
    const p = await proxy()
    const dir = (await project('hosted-not-hosted', files(''))).dir
    const r = await runCli(dir, ['run'], { env: { [VM_URL]: '', [VM_TOKEN]: '' } })
    const out = r.stdout + r.stderr
    assert.equal(r.code, 2, out)
    assert.match(out, /REEVAL_VM_URL/)
    assert.match(out, /REEVAL_VM_TOKEN/)
    assert.doesNotMatch(out, /boat/i)
    assert.deepEqual(p.requests, [])
  })
})
