// Running a file's attempts in its worker (engine/run.ts): leases, cancel, the budget, timeouts,
// console routing, results and records that land after their result.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { budgetMarker } from '../src/engine/cancel.ts'
import { type CollectedTest, collect, registerTest } from '../src/engine/collector.ts'
import { expect } from '../src/engine/expect.ts'
import { loadEvalFile } from '../src/engine/loader.ts'
import type { WireResult } from '../src/engine/protocol.ts'
import { type Reporter, routeConsole, runTests, serializeError } from '../src/engine/run.ts'
import type { TestHandle, TestOptions } from '../src/engine/runtime.ts'
import { useSchedulerChannel } from '../src/scheduler/client.ts'
import type { EvalMeta } from '../src/types.ts'
import { tempDir } from './helpers.ts'

type Event = [string, number | undefined, unknown?]

function recorder() {
  const events: Event[] = []
  const results = new Map<number, WireResult>()
  const reporter: Reporter = {
    start: (i) => events.push(['start', i]),
    progress: (i, p) => events.push(['progress', i, p]),
    debug: (i, l) => events.push(['debug', i, l]),
    log: (i, _at, stream, text) => events.push(['log', i, `${stream}:${text}`]),
    result: (i, r) => {
      events.push(['result', i, r.state])
      results.set(i, r)
    },
    meta: (i, m) => events.push(['meta', i, m]),
  }
  return { events, results, reporter }
}

type Spec = [string, Partial<TestOptions>, (h: TestHandle) => Promise<void>]

async function tests(...specs: Spec[]): Promise<CollectedTest[]> {
  return collect('/f.es.ts', async () => {
    for (const [name, options, body] of specs) registerTest(name, { mode: 'run', ...options }, body)
  })
}

const gate = (limit: number) => () => ({
  limits: { attempts: limit },
  rank: { eval: 'e', file: 'f', order: 0, n: 1, cell: 0 },
})
const stagingDir = () => tempDir('staging')
const meta = { outcome: 'pass' } as unknown as EvalMeta

describe('runTests', () => {
  test('selected run-mode tests run; others are skipped at once, in order', async () => {
    const ran: string[] = []
    const collected = await collect('/f', async () => {
      registerTest('a', { mode: 'run' }, async () => void ran.push('a'))
      registerTest('b', { mode: 'skip' }, async () => void ran.push('b'))
      registerTest('c', { mode: 'run' }, async () => void ran.push('c'))
    })
    const { events, results, reporter } = recorder()
    let ready = 0
    await runTests(collected, new Set([0, 1]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: new AbortController().signal,
      reporter,
      onReady: () => ready++,
    })
    assert.deepEqual(ran, ['a'])
    assert.equal(ready, 1)
    assert.deepEqual(
      events.filter((e) => e[0] === 'result').map((e) => [e[1], e[2]]),
      [
        [1, 'skipped'],
        [2, 'skipped'],
        [0, 'passed'],
      ],
    )
    assert.equal(results.get(1)?.durationMs, 0)
  })

  test('a body that throws fails with its serialized error; one that passes carries its record', async () => {
    const collected = await tests(
      ['fails', {}, async () => expect(1).toBe(2)],
      [
        'passes',
        {},
        async (h) => {
          h.progress({ kind: 'sandbox' })
          h.debug({ phase: 'x' } as never)
          h.setMeta(meta)
        },
      ],
    )
    const { events, results, reporter } = recorder()
    await runTests(collected, new Set([0, 1]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: new AbortController().signal,
      reporter,
      onReady: () => {},
    })
    const failed = results.get(0)
    assert.equal(failed?.state, 'failed')
    assert.equal(failed?.errors[0]?.name, 'AssertionError')
    assert.match(String(failed?.errors[0]?.diff), /Expected/)
    assert.deepEqual(results.get(1)?.meta, meta)
    assert.ok(events.some((e) => e[0] === 'progress' && e[1] === 1))
    assert.ok(events.some((e) => e[0] === 'debug' && e[1] === 1))
    assert.equal(
      events.filter((e) => e[0] === 'meta').length,
      0,
      'a record before the result rides with it',
    )
  })

  test('a timeout fails at the timeout; the body cleans up with its lease and its record follows', async () => {
    let released = false
    const collected = await tests([
      'slow',
      { timeout: 50, gate: gate(1) },
      async (h) => {
        await new Promise((resolve) => h.signal.addEventListener('abort', resolve))
        await new Promise((resolve) => setTimeout(resolve, 30))
        h.setMeta(meta)
        released = true
      },
    ])
    const { events, results, reporter } = recorder()
    await runTests(collected, new Set([0]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: new AbortController().signal,
      reporter,
      onReady: () => {},
    })
    assert.equal(results.get(0)?.state, 'failed')
    assert.equal(results.get(0)?.errors[0]?.message, 'Eval timed out after 0.05s')
    assert.equal(released, true, 'runTests waits for the body')
    assert.deepEqual(events.at(-1), ['meta', 0, meta])
  })

  test('the scheduler holds attempts at the limit; a cancel skips those still waiting', async () => {
    const cancel = new AbortController()
    let running = 0
    const body = async (h: TestHandle) => {
      running++
      cancel.abort()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(h.signal.aborted, true, 'a running attempt sees the cancel')
    }
    const collected = await tests(
      ['one', { gate: gate(1) }, body],
      ['two', { gate: gate(1) }, body],
    )
    const { results, reporter } = recorder()
    await runTests(collected, new Set([0, 1]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: cancel.signal,
      reporter,
      onReady: () => {},
    })
    assert.equal(running, 1)
    assert.equal(results.get(1)?.state, 'skipped')
  })

  test('after a cancel nothing starts, and the budget marker skips attempts that got a lease', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const collected = await tests(['x', { gate: gate(5) }, async () => assert.fail('ran')])
    const a = recorder()
    await runTests(collected, new Set([0]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: cancelled.signal,
      reporter: a.reporter,
      onReady: () => {},
    })
    assert.equal(a.results.get(0)?.state, 'skipped')

    const staging = stagingDir()
    mkdirSync(staging, { recursive: true })
    writeFileSync(budgetMarker(staging), 'budget')
    const b = recorder()
    await runTests(collected, new Set([0]), {
      file: '/f',
      stagingDir: staging,
      signal: new AbortController().signal,
      reporter: b.reporter,
      onReady: () => {},
    })
    assert.equal(b.results.get(0)?.state, 'skipped')
    rmSync(staging, { recursive: true })
  })

  test('a lease request that fails fails its attempt', async () => {
    useSchedulerChannel(() => {
      throw new Error('the channel is gone')
    })
    try {
      const collected = await tests(['x', { gate: gate(1) }, async () => assert.fail('ran')])
      const { results, reporter } = recorder()
      await runTests(collected, new Set([0]), {
        file: '/f',
        stagingDir: stagingDir(),
        signal: new AbortController().signal,
        reporter,
        onReady: () => {},
      })
      assert.equal(results.get(0)?.state, 'failed')
      assert.equal(results.get(0)?.errors[0]?.message, 'the channel is gone')
    } finally {
      // Back to the in-process scheduler for the other tests.
      useSchedulerChannel(() => {})
    }
  })

  test("unawaited assertions and expect.soft fail through the handle's check", async () => {
    let missed: Error | undefined
    let soft: Error | undefined
    const collected = await tests(
      [
        'unawaited',
        {},
        async (h) => {
          void expect(Promise.resolve(1)).resolves.toBe(1)
          missed = await h.unawaited()
        },
      ],
      [
        'soft',
        {},
        async (h) => {
          expect.soft(1).toBe(2)
          soft = await h.unawaited()
        },
      ],
    )
    const { reporter } = recorder()
    await runTests(collected, new Set([0, 1]), {
      file: '/f',
      stagingDir: stagingDir(),
      signal: new AbortController().signal,
      reporter,
      onReady: () => {},
    })
    assert.match(missed?.message ?? '', /wasn't awaited/)
    assert.match(soft?.message ?? '', /expected 1 to be 2/)
  })
})

describe('console routing and error serialization', () => {
  test("console output goes to the attempt that wrote it, or to the file's log", async () => {
    const saved = { ...console }
    const { events, reporter } = recorder()
    routeConsole(reporter)
    try {
      console.log('outside', 1)
      const collected = await tests(['logs', {}, async () => console.error('inside')])
      await runTests(collected, new Set([0]), {
        file: '/f',
        stagingDir: stagingDir(),
        signal: new AbortController().signal,
        reporter,
        onReady: () => {},
      })
    } finally {
      Object.assign(console, saved)
    }
    assert.deepEqual(
      events.filter((e) => e[0] === 'log'),
      [
        ['log', undefined, 'stdout:outside 1\n'],
        ['log', 0, 'stderr:inside\n'],
      ],
    )
  })

  test('serializeError maps stacks, and serializes anything thrown', async () => {
    const root = tempDir('serialize')
    const file = join(root, 'x.ts')
    writeFileSync(file, 'type T = 1\nexport function f(): void {\n  throw new Error("mapped")\n}\n')
    const { f } = (await loadEvalFile(file, root)) as { f: () => void }
    let thrown: Error | undefined
    try {
      f()
    } catch (error) {
      thrown = error as Error
    }
    const serialized = serializeError(thrown)
    assert.match(String(serialized.stack), new RegExp(`${file}:3:9`))
    assert.deepEqual(serializeError('plain'), { message: 'plain' })
    // A stack that can't be mapped (its file is gone) is kept as it was.
    const again = new Error('kept')
    again.stack = `Error: kept\n    at ${file}:3:9`
    rmSync(file)
    assert.match(String(serializeError(again).stack), /x\.ts:3:9/)
  })
})
