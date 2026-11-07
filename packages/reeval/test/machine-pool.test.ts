// The machine pool on a fake provider that rate-limits: starts held to the windows, 429s waited
// out (as the provider asks, else with backoff) without failing an attempt, real failures failing
// one, slots reused or not, machines shared, idle and broken ones removed, and close removing all.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MachinePool,
  type PoolOptions,
  type PoolProvider,
  type RateLimited,
} from '../src/sandbox/pool.ts'

class RateLimitError extends Error {
  readonly retryAfterMs: number | null
  constructor(retryAfterMs: number | null) {
    super(`429 rate_limited${retryAfterMs === null ? '' : `: retry after ${retryAfterMs}ms`}`)
    this.retryAfterMs = retryAfterMs
  }
}

type Fake = PoolProvider<{ host: string }> & {
  started: Array<{ id: string; at: number }>
  tries: number[]
  removed: string[]
  kept: string[]
  live: () => string[]
}

/**
 * A provider whose `start` asks `answer` what to do with try `n`: start, be rate-limited, fail,
 * or hang until the pool aborts it.
 */
function fakeProvider(
  answer: (n: number) => 'ok' | RateLimitError | Error | 'hang' = () => 'ok',
  o: { startMs?: number } = {},
): Fake {
  let n = 0
  const t0 = performance.now()
  const live = new Set<string>()
  const fake: Fake = {
    helper: 'fake()',
    started: [],
    tries: [],
    removed: [],
    kept: [],
    live: () => [...live],
    async start(signal) {
      const at = performance.now() - t0
      fake.tries.push(at)
      const what = answer(n++)
      if (what instanceof Error) throw what
      if (what === 'hang') {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      }
      await new Promise((r) => setTimeout(r, o.startMs ?? 5))
      const id = `m${fake.started.length + 1}`
      fake.started.push({ id, at })
      live.add(id)
      return { id, info: { host: `${id}.test` } }
    },
    async remove(id) {
      fake.removed.push(id)
      live.delete(id)
    },
    async keepAlive(id) {
      fake.kept.push(id)
    },
    rateLimited: (error): RateLimited | null =>
      error instanceof RateLimitError ? { retryAfterMs: error.retryAfterMs } : null,
  }
  return fake
}

const pool = (provider: Fake, o: Partial<PoolOptions> = {}) =>
  new MachinePool(provider, {
    limits: { machines: 10 },
    attemptsPerMachine: 1,
    reuse: false,
    idleMs: 60_000,
    ...o,
  })

const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('machine pool', () => {
  test('holds starts to the per-minute window, sliding', async () => {
    const provider = fakeProvider()
    const p = pool(provider, {
      limits: { machines: 10, startsPerMinute: 3 },
      windowsMs: { minute: 300, hour: 60_000 },
    })
    const leases = await Promise.all(Array.from({ length: 7 }, () => p.acquire()))
    const at = provider.tries.map((t) => Math.floor(t / 300))
    assert.deepEqual(at, [0, 0, 0, 1, 1, 1, 2])
    assert.equal(new Set(leases.map((l) => l.machine)).size, 7)
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('the hour window counts too', async () => {
    const provider = fakeProvider()
    const p = pool(provider, {
      limits: { machines: 10, startsPerMinute: 10, startsPerHour: 2 },
      windowsMs: { minute: 50, hour: 400 },
    })
    await Promise.all(Array.from({ length: 3 }, () => p.acquire()))
    assert.deepEqual(
      provider.tries.map((t) => t >= 400),
      [false, false, true],
    )
    await p.close()
  })

  test('a 429 with Retry-After holds every start that long, then the start goes through', async () => {
    const provider = fakeProvider((n) => (n === 0 ? new RateLimitError(200) : 'ok'))
    const p = pool(provider)
    const first = p.acquire()
    await until(() => p.stats().rateLimited === 1)
    const second = p.acquire()
    const leases = await Promise.all([first, second])
    assert.equal(p.stats().rateLimited, 1)
    // The second start was asked for during the hold, so it waited it out too.
    assert.ok(
      provider.tries.slice(1).every((t) => t >= 195),
      String(provider.tries),
    )
    assert.deepEqual(leases.map((l) => l.start?.rateLimited ?? 0).sort(), [0, 1])
    await p.close()
  })

  test('a 429 without Retry-After backs off, doubling', async () => {
    const provider = fakeProvider((n) => (n < 3 ? new RateLimitError(null) : 'ok'))
    const p = pool(provider, { backoffMs: 40, maxBackoffMs: 1_000 })
    const lease = await p.acquire()
    const gaps = provider.tries.slice(1).map((t, i) => t - (provider.tries[i] as number))
    assert.ok(gaps[0] !== undefined && gaps[0] >= 38, String(gaps))
    assert.ok(gaps[1] !== undefined && gaps[1] >= 78, String(gaps))
    assert.ok(gaps[2] !== undefined && gaps[2] >= 158, String(gaps))
    assert.deepEqual(lease.start?.rateLimited, 3)
    assert.equal(p.stats().rateLimited, 3)
    await p.close()
  })

  test('rate limits past maxRateWaitMs fail the attempt, naming the provider and its answer', async () => {
    const provider = fakeProvider(() => new RateLimitError(150))
    const p = pool(provider, { maxRateWaitMs: 200 })
    await assert.rejects(
      p.acquire(),
      /fake\(\) kept refusing to start a machine .*429 rate_limited/,
    )
    await p.close()
  })

  test('a real start failure fails one attempt; the others start', async () => {
    const provider = fakeProvider((n) => (n === 0 ? new Error('quota exceeded') : 'ok'))
    const p = pool(provider)
    const results = await Promise.allSettled([p.acquire(), p.acquire(), p.acquire()])
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'fulfilled', 'fulfilled'],
    )
    assert.match(String((results[0] as PromiseRejectedResult).reason), /quota exceeded/)
    assert.equal(provider.tries.length, 3)
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('without reuse, a released machine goes at once and the next attempt starts another', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 } })
    const a = await p.acquire()
    a.release()
    await until(() => provider.removed.includes(a.machine))
    const b = await p.acquire()
    assert.notEqual(b.machine, a.machine)
    assert.equal(b.reused, 0)
    await p.close()
    assert.equal(p.stats().starts, 2)
  })

  test('with reuse, the next attempt takes the slot, keeping the machine alive', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 }, reuse: true })
    const a = await p.acquire()
    assert.equal(a.reused, 0)
    assert.ok(a.start)
    a.release()
    const b = await p.acquire()
    assert.equal(b.machine, a.machine)
    assert.equal(b.reused, 1)
    assert.equal(b.start, null)
    assert.deepEqual(provider.kept, [a.machine])
    b.release()
    assert.deepEqual(p.stats(), {
      starts: 1,
      rateLimited: 0,
      machinesAtOnce: 1,
      leases: 2,
      reusedLeases: 1,
    })
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('a broken slot takes its machine out; the next attempt gets a new one', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 }, reuse: true })
    const a = await p.acquire()
    a.release(true)
    const b = await p.acquire()
    assert.notEqual(b.machine, a.machine)
    assert.ok(provider.removed.includes(a.machine))
    await p.close()
  })

  test('attemptsPerMachine shares one start between slots', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 2 }, attemptsPerMachine: 3 })
    const leases = await Promise.all(Array.from({ length: 5 }, () => p.acquire()))
    assert.equal(provider.started.length, 2)
    const byMachine = Object.groupBy(leases, (l) => l.machine)
    assert.deepEqual(
      Object.values(byMachine).map((ls) => ls?.map((l) => l.slot).sort()),
      [
        [0, 1, 2],
        [0, 1],
      ],
    )
    // Without reuse a machine goes once all its slots are done.
    for (const l of byMachine.m1 ?? []) l.release()
    await until(() => provider.removed.includes('m1'))
    assert.deepEqual(provider.live(), ['m2'])
    await p.close()
  })

  test('the pool runs at most `machines` × attemptsPerMachine; the rest wait for a slot', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 }, reuse: true, attemptsPerMachine: 2 })
    const [a, b] = await Promise.all([p.acquire(), p.acquire()])
    let third: string | undefined
    const waiting = p.acquire().then((l) => {
      third = l.machine
      return l
    })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(third, undefined)
    a?.release()
    const c = await waiting
    assert.equal(c.slot, a?.slot)
    assert.equal(provider.started.length, 1)
    b?.release()
    c.release()
    await p.close()
  })

  test('an idle slot goes after idleMs, and its machine with it', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { reuse: true, idleMs: 50 })
    const a = await p.acquire()
    a.release()
    await until(() => provider.removed.includes(a.machine))
    await p.close()
  })

  test('close removes machines in use and starting, and fails the attempts waiting', async () => {
    const provider = fakeProvider((n) => (n === 0 ? 'ok' : 'hang'))
    const p = pool(provider)
    const a = await p.acquire()
    const waiting = p.acquire()
    await until(() => provider.tries.length === 2)
    await p.close()
    await assert.rejects(waiting, /machine pool closed/)
    assert.deepEqual(provider.removed, [a.machine])
    assert.deepEqual(provider.live(), [])
    a.release()
    await assert.rejects(p.acquire(), /machine pool is closed/)
  })

  test('an aborted acquire stops waiting', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 } })
    const a = await p.acquire()
    const stop = new AbortController()
    const waiting = p.acquire({ signal: stop.signal })
    stop.abort(new Error('the attempt was canceled'))
    await assert.rejects(waiting, /the attempt was canceled/)
    a.release()
    await p.close()
  })
})
