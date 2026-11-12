// The machine pool on a fake provider that rate-limits: starts held to the windows, 429s waited
// out (as the provider asks, else with backoff) without failing an attempt, real failures failing
// one, slots reused or not, machines shared, idle and broken ones removed, and close removing all;
// and pools on one account sharing its machines and starts, an idle machine making way for
// another pool's.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MachinePool,
  type PoolOptions,
  type PoolProvider,
  type RateLimited,
} from '../src/sandbox/pool.ts'
import { type AccountOptions, PoolAccount } from '../src/sandbox/pool-account.ts'
import { MachineReclaimed, RunStopped } from '../src/sandbox/types.ts'

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
  /** What each keep-alive asked: the machine and its TTL from now. */
  keptFor: number[]
  live: () => string[]
  /** The most machines that were up at once. */
  peak: () => number
}

/**
 * A provider whose `start` asks `answer` what to do with try `n`: start, be rate-limited, fail,
 * or hang until the pool aborts it.
 */
function fakeProvider(
  answer: (n: number) => 'ok' | RateLimitError | Error | 'hang' = () => 'ok',
  o: { startMs?: number; removeMs?: number; keepAlive?: (id: string) => void } = {},
): Fake {
  let n = 0
  const t0 = performance.now()
  const live = new Set<string>()
  let peak = 0
  const fake: Fake = {
    helper: 'fake()',
    started: [],
    tries: [],
    removed: [],
    kept: [],
    keptFor: [],
    live: () => [...live],
    peak: () => peak,
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
      peak = Math.max(peak, live.size)
      return { id, info: { host: `${id}.test` } }
    },
    async remove(id) {
      fake.removed.push(id)
      if (o.removeMs) await new Promise((r) => setTimeout(r, o.removeMs))
      live.delete(id)
    },
    async keepAlive(id, ttlSeconds) {
      fake.kept.push(id)
      fake.keptFor.push(ttlSeconds)
      o.keepAlive?.(id)
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

  test('a run-wide start limit is spent once, never refilled, and a refused start keeps its share', async () => {
    const provider = fakeProvider((n) => (n === 0 ? new RateLimitError(10) : 'ok'))
    const p = pool(provider, { limits: { machines: 10, starts: 2 } })
    const results = await Promise.allSettled([p.acquire(), p.acquire(), p.acquire()])
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'fulfilled', 'rejected'])
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.match(String(failed.reason), /fake\(\) has used every machine start the run has \(2\)/)
    assert.equal(provider.started.length, 2)
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

  test('with maxRateWaitMs Infinity, rate limits are waited out however long they last', async () => {
    const provider = fakeProvider((n) => (n < 6 ? new RateLimitError(30) : 'ok'))
    const p = pool(provider, { maxRateWaitMs: Number.POSITIVE_INFINITY })
    const lease = await p.acquire()
    assert.equal(lease.start?.rateLimited, 6)
    await p.close()
  })

  test('with maxRateWaitMs Infinity, an aborted acquire stops its wait at once and asks no more', async () => {
    const provider = fakeProvider(() => new RateLimitError(60_000))
    const p = pool(provider, { maxRateWaitMs: Number.POSITIVE_INFINITY })
    const stop = new AbortController()
    const waiting = p.acquire({ signal: stop.signal })
    await until(() => p.stats().rateLimited === 1)
    const t0 = performance.now()
    stop.abort(new Error('the attempt was canceled'))
    await assert.rejects(waiting, /the attempt was canceled/)
    assert.ok(performance.now() - t0 < 1_000)
    assert.equal(provider.tries.length, 1)
    await p.close()
  })

  test('the provider ending the run fails its attempts, and the pool asks it for no more', async () => {
    let asked = 0
    const provider = fakeProvider((n) => {
      asked = n + 1
      return n === 0 ? new RunStopped('fake() ended the run') : 'ok'
    })
    const p = pool(provider, { limits: { machines: 1 }, maxRateWaitMs: Number.POSITIVE_INFINITY })
    await assert.rejects(p.acquire(), (error) => error instanceof RunStopped)
    await assert.rejects(p.acquire(), (error) => error instanceof RunStopped)
    assert.equal(asked, 1)
    assert.equal(p.stats().rateLimited, 0)
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

  test('a new machine starts only once the provider has room: one being removed, or still running a slot, holds its place', async () => {
    const provider = fakeProvider(() => 'ok', { removeMs: 50 })
    const p = pool(provider, { limits: { machines: 1 }, attemptsPerMachine: 2 })
    const [a, b] = await Promise.all([p.acquire(), p.acquire()])
    a?.release()
    const waiting = p.acquire()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(provider.started.length, 1, 'slot 1 still runs on the only machine')
    b?.release()
    const c = await waiting
    assert.notEqual(c.machine, a?.machine)
    assert.equal(provider.peak(), 1)
    c.release()
    const d = await p.acquire()
    assert.equal(provider.peak(), 1)
    d.release()
    await p.close()
    assert.deepEqual(provider.live(), [])
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
      keepAliveFailed: 0,
      reclaimed: 0,
      evicted: 0,
    })
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('a reused machine is kept alive for the longest TTL any attempt asked, from now', async () => {
    const provider = fakeProvider()
    const p = pool(provider, { limits: { machines: 1 }, reuse: true })
    ;(await p.acquire({ ttlSeconds: 900 })).release()
    ;(await p.acquire({ ttlSeconds: 300 })).release()
    assert.deepEqual(provider.keptFor, [900])
    await p.close()
  })

  test('a machine that fails its keep-alive goes, and the attempt gets a new one', async () => {
    const provider = fakeProvider(() => 'ok', {
      keepAlive: (id) => {
        if (id === 'm1') throw new Error('404 sandbox not found')
      },
    })
    const p = pool(provider, { limits: { machines: 1 }, reuse: true })
    const a = await p.acquire()
    a.release()
    const b = await p.acquire()
    assert.equal(b.machine, 'm2')
    assert.ok(b.start, 'a new machine')
    assert.deepEqual(b.lost, [{ machine: 'm1', error: '404 sandbox not found' }])
    assert.ok(provider.removed.includes('m1'))
    assert.equal(p.stats().keepAliveFailed, 1)
    b.release()
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('a machine the provider takes back at its keep-alive goes as no failure, and the attempt gets a new one', async () => {
    const provider = fakeProvider(() => 'ok', {
      keepAlive: (id) => {
        if (id === 'm1') throw new MachineReclaimed('took m1 back: 409 vm_released')
      },
    })
    const p = pool(provider, { limits: { machines: 1 }, reuse: true })
    ;(await p.acquire()).release()
    const b = await p.acquire()
    assert.equal(b.machine, 'm2')
    assert.ok(b.start, 'a new machine')
    assert.deepEqual(b.lost, [
      { machine: 'm1', error: 'took m1 back: 409 vm_released', reclaimed: true },
    ])
    assert.ok(provider.removed.includes('m1'))
    assert.equal(p.stats().reclaimed, 1)
    assert.equal(p.stats().keepAliveFailed, 0)
    b.release()
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('a keep-alive that says the run ended stops its attempts, starting no machine for them', async () => {
    const ended = new RunStopped('the service ended the run')
    const provider = fakeProvider(() => 'ok', {
      keepAlive: () => {
        throw ended
      },
    })
    const p = pool(provider, { limits: { machines: 2 }, reuse: true })
    ;(await p.acquire()).release()
    await assert.rejects(p.acquire(), ended)
    await assert.rejects(p.acquire(), ended)
    assert.deepEqual(
      provider.started.map((s) => s.id),
      ['m1'],
    )
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test('a packed machine taken back keeps its running attempt, takes no new one and goes after it', async () => {
    const provider = fakeProvider(() => 'ok', {
      keepAlive: (id) => {
        throw new MachineReclaimed(`took ${id} back`)
      },
    })
    const p = pool(provider, { limits: { machines: 3 }, attemptsPerMachine: 2 })
    const a = await p.acquire()
    const b = await p.acquire()
    assert.deepEqual(provider.kept, ['m1'], "the second slot's lease asks to keep m1")
    assert.equal(a.machine, 'm1')
    assert.equal(b.machine, 'm2')
    assert.deepEqual(provider.removed, [], 'm1 stays while its first attempt runs')
    const c = await p.acquire()
    assert.notEqual(c.machine, 'm1', 'a machine taken back takes no new attempt')
    a.release()
    await until(() => provider.removed.includes('m1'))
    assert.ok(!provider.live().includes('m1'))
    b.release()
    c.release()
    await p.close()
    assert.deepEqual(provider.live(), [])
  })

  test("a start waiting on the hour's cap past maxRateWaitMs fails, naming the cap", async () => {
    const provider = fakeProvider()
    const p = pool(provider, {
      limits: { machines: 10, startsPerHour: 1 },
      windowsMs: { minute: 60_000, hour: 60_000 },
      maxRateWaitMs: 150,
    })
    const first = await p.acquire()
    assert.ok(first.start && first.start.queuedMs < 100)
    await assert.rejects(
      p.acquire(),
      /fake\(\) had no room to start a machine for \d+s: the account's starts are capped at 1 an hour/,
    )
    assert.equal(provider.tries.length, 1)
    await p.close()
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

  test('an acquire aborted while its machine starts, with none other waiting, removes the machine once it is up', async () => {
    const provider = fakeProvider(() => 'ok', { startMs: 50 })
    const p = pool(provider, { idleMs: 100 })
    const stop = new AbortController()
    const waiting = p.acquire({ signal: stop.signal })
    await new Promise((r) => setTimeout(r, 10))
    stop.abort(new Error('the attempt was canceled'))
    await assert.rejects(waiting, /the attempt was canceled/)
    for (let i = 0; i < 100 && provider.removed.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(provider.removed, ['m1'], 'the machine nobody waits for is removed')
    assert.deepEqual(provider.live(), [])
    await p.close()
  })

  test('an acquire aborted while its start waits for the window, or boots, with none other waiting, stops the start', async () => {
    const provider = fakeProvider(() => 'ok', { startMs: 100 })
    // Like Boat dropping a delete sent mid-provision: a start cut short leaves its machine up.
    const start = provider.start.bind(provider)
    provider.start = async (signal, ttlSeconds) => {
      const started = await start(signal, ttlSeconds)
      signal.throwIfAborted()
      return started
    }
    const p = pool(provider, {
      limits: { machines: 10, startsPerMinute: 2 },
      windowsMs: { minute: 60_000, hour: 3_600_000 },
    })
    try {
      const a = await p.acquire()
      const booting = new AbortController()
      const boots = p.acquire({ signal: booting.signal })
      await until(() => provider.tries.length === 2)
      booting.abort(new Error('canceled'))
      await assert.rejects(boots, /canceled/)
      const queued = new AbortController()
      const waits = p.acquire({ signal: queued.signal })
      await new Promise((r) => setTimeout(r, 20))
      queued.abort(new Error('canceled'))
      await assert.rejects(waits, /canceled/)
      await until(() => provider.removed.length === 1)
      assert.equal(provider.tries.length, 2, 'the queued start never went out')
      assert.deepEqual(
        provider.removed,
        ['m2'],
        'the booting start is removed once up, not cut short',
      )
      assert.deepEqual(provider.live(), [a.machine])
      a.release()
    } finally {
      await p.close()
    }
  })
})

describe('pools on one account', () => {
  const account = (o: AccountOptions) => new PoolAccount('fake()', o)

  test('a start with no bound on its wait waits out a held window', async () => {
    const shared = account({ limits: { machines: 1, startsPerMinute: 10 } })
    shared.hold(80)
    const t0 = performance.now()
    const stop = new AbortController()
    const got = await shared.gate(
      async () => 'started',
      Number.POSITIVE_INFINITY,
      stop.signal,
      () => {},
    )
    assert.equal(got, 'started')
    assert.ok(performance.now() - t0 >= 70)
    shared.close()
  })

  test('a start with no bound on its wait stops waiting when aborted', async () => {
    const shared = account({ limits: { machines: 1, startsPerMinute: 10 } })
    shared.hold(60_000)
    const stop = new AbortController()
    let started = false
    const gated = shared.gate(
      async () => {
        started = true
        return 'started'
      },
      Number.POSITIVE_INFINITY,
      stop.signal,
      () => {},
    )
    const t0 = performance.now()
    stop.abort(new Error('the attempt was canceled'))
    await assert.rejects(gated, /the attempt was canceled/)
    assert.ok(performance.now() - t0 < 1_000)
    assert.equal(started, false)
    shared.close()
  })

  test("share the account's machines: a pool waits while the others hold them all", async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 2 } })
    const a = pool(provider, { account: shared })
    const b = pool(provider, { account: shared })
    try {
      const [a1, a2] = await Promise.all([a.acquire(), a.acquire()])
      let got: string | undefined
      const waiting = b.acquire().then((l) => {
        got = l.machine
        return l
      })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(got, undefined, 'b waits: the account has no machine to spare')
      a1.release()
      const b1 = await waiting
      assert.equal(provider.peak(), 2)
      a2.release()
      b1.release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
    assert.deepEqual(provider.live(), [])
  })

  test("share the account's start windows", async () => {
    const provider = fakeProvider()
    const shared = account({
      limits: { machines: 10, startsPerMinute: 2 },
      windowsMs: { minute: 300, hour: 60_000 },
    })
    const a = pool(provider, { account: shared })
    const b = pool(provider, { account: shared })
    try {
      const leases = await Promise.all([a.acquire(), b.acquire(), a.acquire(), b.acquire()])
      const at = provider.started.map((s) => s.at).sort((x, y) => x - y)
      assert.ok((at[2] as number) - (at[0] as number) >= 250, `starts at ${at.join(', ')}`)
      for (const l of leases) l.release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  test("a 429 in one pool holds the other pool's starts too", async () => {
    let refused = false
    const provider = fakeProvider((n) => {
      if (n !== 0 || refused) return 'ok'
      refused = true
      return new RateLimitError(200)
    })
    const shared = account({ limits: { machines: 10 } })
    const a = pool(provider, { account: shared })
    const b = pool(provider, { account: shared })
    try {
      const first = a.acquire()
      await until(() => provider.tries.length === 1)
      await new Promise((r) => setTimeout(r, 20))
      const second = await b.acquire()
      assert.ok((provider.tries[1] as number) >= 150, `b tried at ${provider.tries[1]}ms`)
      second.release()
      ;(await first).release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  test("a pool that needs a machine has another pool's idle one removed for it", async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 1 } })
    const a = pool(provider, { account: shared, reuse: true })
    const b = pool(provider, { account: shared, reuse: true })
    try {
      const a1 = await a.acquire()
      a1.release()
      const b1 = await b.acquire()
      assert.deepEqual(provider.removed, [a1.machine])
      assert.notEqual(b1.machine, a1.machine)
      assert.equal(a.stats().evicted, 1)
      b1.release()
      const a2 = await a.acquire()
      assert.deepEqual(provider.removed, [a1.machine, b1.machine], 'and back again')
      a2.release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
    assert.deepEqual(provider.live(), [])
  })

  test('the machine idle longest goes, never one in use', async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 3 } })
    const a = pool(provider, { account: shared, reuse: true })
    const c = pool(provider, { account: shared, reuse: true })
    const b = pool(provider, { account: shared, reuse: true })
    try {
      const [a1, c1, c2] = await Promise.all([a.acquire(), c.acquire(), c.acquire()])
      a1.release()
      await new Promise((r) => setTimeout(r, 20))
      c1.release()
      const b1 = await b.acquire()
      assert.deepEqual(provider.removed, [a1.machine], "a's went idle first")
      const b2 = b.acquire()
      await until(() => provider.removed.length === 2)
      assert.deepEqual(provider.removed, [a1.machine, c1.machine], "c's other machine is in use")
      ;(await b2).release()
      b1.release()
      c2.release()
    } finally {
      await Promise.all([a.close(), b.close(), c.close()])
    }
  })

  test("a pool at its own cap waits for its own machines, removing none of another pool's", async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 2 } })
    const a = pool(provider, { account: shared, reuse: true })
    const b = pool(provider, { account: shared, machines: 1 })
    try {
      ;(await a.acquire()).release()
      const b1 = await b.acquire()
      let got = false
      const waiting = b.acquire().then((l) => {
        got = true
        return l
      })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(got, false)
      assert.deepEqual(provider.removed, [], "a's idle machine stays")
      b1.release()
      ;(await waiting).release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  test("a closed pool's machines give the account its room back", async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 1 } })
    const a = pool(provider, { account: shared })
    const b = pool(provider, { account: shared })
    try {
      await a.acquire()
      const waiting = b.acquire()
      await new Promise((r) => setTimeout(r, 20))
      await a.close()
      ;(await waiting).release()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  test('pools waiting at once have one idle machine removed each, not one per wake-up', async () => {
    const provider = fakeProvider(() => 'ok', { removeMs: 30 })
    const shared = account({ limits: { machines: 8 } })
    const a = pool(provider, { account: shared, reuse: true })
    const others = [1, 2, 3, 4].map(() => pool(provider, { account: shared, reuse: true }))
    try {
      const held = await Promise.all(Array.from({ length: 8 }, () => a.acquire()))
      for (const l of held) l.release()
      const got = await Promise.all(others.map((p) => p.acquire()))
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(a.stats().evicted, 4)
      assert.equal(provider.removed.length, 4)
      for (const l of got) l.release()
    } finally {
      await Promise.all([a, ...others].map((p) => p.close()))
    }
  })

  test("a pool waiting while another's machine is in use gets it next, before that pool's next attempt", async () => {
    const provider = fakeProvider()
    const shared = account({ limits: { machines: 1 } })
    const a = pool(provider, { account: shared, reuse: true })
    const b = pool(provider, { account: shared, reuse: true })
    try {
      const order: string[] = []
      const first = await a.acquire()
      const waiting = b.acquire().then((l) => {
        order.push('b')
        l.release()
      })
      await new Promise((r) => setTimeout(r, 10))
      const next = a.acquire().then((l) => {
        order.push('a')
        l.release()
      })
      first.release()
      await Promise.all([waiting, next])
      assert.deepEqual(order, ['b', 'a'])
      assert.deepEqual(provider.removed, [first.machine, 'm2'], "and b's goes for a's attempt")
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })
})
