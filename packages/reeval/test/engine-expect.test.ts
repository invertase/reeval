// The standalone `expect` (engine/expect.ts): Vitest's matchers from @vitest/expect, routed to the
// attempt that asserts, with reeval's shims for the runner state @vitest/expect expects.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { assertionRecords, checkFailure } from '../src/attempt/assertions.ts'
import {
  attemptExpectError,
  attemptRecordings,
  createExpect,
  type ExpectTask,
  expect,
  extendExpect,
  type Pending,
  rawAssertions,
  SUBJECT,
  unawaitedError,
  withAttemptExpect,
} from '../src/engine/expect.ts'

const task = (): ExpectTask => ({ type: 'test', name: 't', fullTestName: 'file > t' })
/** The task's records, as the attempt makes them from the engine's raw entries. */
const records = (t: ExpectTask) => assertionRecords(rawAssertions(t))
const fails = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, pattern)

describe('standalone expect', () => {
  test("Vitest's matchers, asymmetric matchers, .not and diffs work unchanged", async () => {
    expect(1).toBe(1)
    expect({ a: [1, 2] }).toEqual({ a: [1, expect.any(Number)] })
    expect('hello').toEqual(expect.stringContaining('ell'))
    expect([1]).not.toContain(2)
    expect(3).toBeOneOf([1, 2, 3])
    await expect(Promise.resolve(2)).resolves.toBe(2)
    await expect(Promise.reject(new Error('no'))).rejects.toThrow('no')
    try {
      expect({ a: 1, b: 'x' }).toEqual({ a: 1, b: 'y' })
      assert.fail('should have thrown')
    } catch (error) {
      const e = error as Error & { actual: unknown; expected: unknown; showDiff: boolean }
      assert.equal(e.name, 'AssertionError')
      assert.match(e.message, /expected \{ a: 1, b: 'x' \} to deeply equal \{ a: 1, b: 'y' \}/)
      assert.equal(e.showDiff, true)
      assert.deepEqual(
        [e.actual, e.expected],
        [
          { a: 1, b: 'x' },
          { a: 1, b: 'y' },
        ],
      )
    }
    // Canary: a wrong expectation fails.
    fails(() => expect(1).toBe(2), /expected 1 to be 2/)
  })

  test('each expect counts its own assertions, and expect.assertions checks the count', () => {
    const t = task()
    const own = createExpect(t)
    own.assertions(2)
    own(1).toBe(1)
    assert.equal(own.getState().assertionCalls, 1)
    assert.equal(own.getState().currentTestName, 'file > t')
    assert.match(
      attemptExpectError(own)?.message ?? '',
      /expected number of assertions to be 2, but got 1/,
    )
    own(2).toBe(2)
    assert.equal(attemptExpectError(own), undefined)
    // Another attempt's expect is untouched.
    assert.equal(createExpect(task()).getState().assertionCalls, 0)
    assert.equal(createExpect().getState().currentTestName, '')
    own.setState({ assertionCalls: 7 })
    assert.equal(own.getState().assertionCalls, 7)
  })

  test('expect.hasAssertions fails an attempt that asserted nothing', () => {
    const t = task()
    const own = createExpect(t)
    own.hasAssertions()
    assert.equal(attemptExpectError(own)?.message, 'expected any number of assertion, but got none')
    own(true).toBe(true)
    assert.equal(attemptExpectError(own), undefined)
  })

  test("calls made outside expect join the running attempt's records", async () => {
    const t = task()
    const own = createExpect(t)
    await withAttemptExpect(own, [], async () => {
      own(1).toBe(1)
      attemptRecordings().push({ matcher: 'assert', args: [], soft: false, status: 'pass' })
    })
    assert.deepEqual(
      records(t).map((r) => r.label),
      ['toBe 1', 'assert'],
    )
    fails(() => attemptRecordings(), /only called inside an attempt/)
  })

  test('expect.soft records a failure on the attempt and carries on', () => {
    const t = task()
    const own = createExpect(t)
    assert.equal(own.soft(1).toBe(2), undefined)
    own.soft(3).toBe(3)
    assert.equal(attemptExpectError(own), undefined, 'a soft failure is not a count error')
    const error = checkFailure(rawAssertions(t))
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'AssertionError')
    assert.match(error.message, /expected 1 to be 2/)
    // Without an attempt, soft has nowhere to record.
    fails(() => createExpect().soft(1).toBe(2), /expect\.soft\(\) can only be used inside a test/)
  })

  test('expect.poll retries until the matcher passes', async () => {
    let n = 0
    await createExpect()
      .poll(() => ++n, { interval: 5, timeout: 1000 })
      .toBe(3)
    assert.equal(n, 3)
    await createExpect()
      .poll(async () => 'ready')
      .not.toBe('waiting')
  })

  test('expect.poll refuses a timeout or interval longer than a timer can be', () => {
    for (const key of ['timeout', 'interval']) {
      fails(
        () => createExpect().poll(() => 1, { [key]: 2 ** 31 }),
        new RegExp(
          `expect\\.poll's ${key} is at most 596h \\(2147483647ms\\), the longest timer Node can set \\(got 2147483648\\)$`,
        ),
      )
      createExpect().poll(() => 1, { [key]: 2 ** 31 - 1 })
    }
  })

  test('expect.poll fails with the last error at its timeout, pointing at the call', async () => {
    const poll = createExpect().poll(() => 'no', { interval: 10, timeout: 60, message: 'ready?' })
    await assert.rejects(
      () => poll.toBe('yes') as unknown as Promise<void>,
      (error: Error) => {
        assert.match(error.message, /ready\?: expected 'no' to be 'yes'/)
        assert.match(error.stack ?? '', /engine-expect\.test\.ts/)
        return true
      },
    )
    // A thrown non-Error is passed through as is.
    await assert.rejects(
      () =>
        createExpect()
          .poll(
            () => {
              throw 'not an error'
            },
            { interval: 10, timeout: 20 },
          )
          .toBe(1) as unknown as Promise<void>,
      (thrown) => thrown === 'not an error',
    )
    // Flags on the poll assertion that aren't chains come back unchanged.
    assert.equal(typeof createExpect().poll(() => 1).__flags, 'object')
  })

  test('expect.unreachable, addEqualityTesters, assert and extend', () => {
    fails(() => expect.unreachable(), /expected not to be reached/)
    fails(() => expect.unreachable('here'), /expected "here" not to be reached/)
    expect.assert.equal(1, 1)
    const own = createExpect()
    own.addEqualityTesters([
      (a: unknown, b: unknown) =>
        typeof a === 'string' && typeof b === 'string'
          ? a.toLowerCase() === b.toLowerCase()
          : undefined,
    ])
    own('ABC').toEqual('abc')
    extendExpect({
      toBeEven: (actual) => ({
        pass: (actual as number) % 2 === 0,
        message: () => `expected ${actual} to be even`,
      }),
    })
    ;(expect(4) as unknown as { toBeEven(): void }).toBeEven()
    fails(() => (expect(3) as unknown as { toBeEven(): void }).toBeEven(), /expected 3 to be even/)
  })
})

describe('assertions recorded on the attempt', () => {
  const named = <T extends object>(value: T, subject: unknown) =>
    Object.defineProperty(value, SUBJECT, { value: subject })

  test('each matcher call is recorded in call order: its label, matcher, status and message', async () => {
    const t = task()
    const own = createExpect(t)
    own(1, 'one').toBe(1)
    own(1).not.toBe(2)
    assert.throws(() => own(1).toBe(2), /expected 1 to be 2/)
    own('x', '').toBe('x')
    await own(Promise.resolve(3)).resolves.toBe(3)
    await assert.rejects(() => own(Promise.resolve(3), 'three').resolves.toBe(4) as never)
    own('abc').to.equal('abc').and.have.length(3)
    own('abc').to.have.length.of.at.least(2)
    assert.equal(typeof own([1]).to.include.name, 'string')
    assert.equal(typeof own(1)[Symbol.toStringTag as never], 'undefined')
    own.assertions(9)
    assert.deepEqual(
      records(t).map(({ durationMs, ...x }) => x),
      [
        { label: 'one', labelled: true, matcher: 'toBe', status: 'pass', soft: false },
        { label: 'not.toBe 2', labelled: false, matcher: 'not.toBe', status: 'pass', soft: false },
        {
          label: 'toBe 2',
          labelled: false,
          matcher: 'toBe',
          status: 'fail',
          soft: false,
          message: 'expected 1 to be 2 // Object.is equality',
        },
        { label: 'toBe x', labelled: false, matcher: 'toBe', status: 'pass', soft: false },
        {
          label: 'resolves.toBe 3',
          labelled: false,
          matcher: 'resolves.toBe',
          status: 'pass',
          soft: false,
        },
        {
          label: 'three',
          labelled: true,
          matcher: 'resolves.toBe',
          status: 'fail',
          soft: false,
          message: 'three: expected 3 to be 4 // Object.is equality',
        },
        { label: 'equal abc', labelled: false, matcher: 'equal', status: 'pass', soft: false },
        { label: 'length 3', labelled: false, matcher: 'length', status: 'pass', soft: false },
        { label: 'least 2', labelled: false, matcher: 'least', status: 'pass', soft: false },
      ],
    )
    const timed = records(t).filter((x) => x.durationMs !== undefined)
    assert.deepEqual(
      timed.map((x) => x.label),
      ['resolves.toBe 3', 'three'],
      'only async matchers are timed',
    )
    // Canary: a label the eval gave is never replaced by the default.
    assert.notEqual(records(t)[0]?.label, 'toBe 1')
  })

  test('a soft matcher records its own outcome, fails the attempt at the end and carries on', async () => {
    const t = task()
    const own = createExpect(t)
    own.soft(1, 'first').toBe(2)
    own.soft(2).toBe(2)
    await own.soft(Promise.resolve(1), 'later').resolves.toBe(5)
    await own.soft(Promise.resolve(1)).resolves.toBe(1)
    own.soft(3).toBe(4)
    assert.deepEqual(
      records(t).map((x) => [x.label, x.status, x.soft]),
      [
        ['first', 'fail', true],
        ['toBe 2', 'pass', true],
        ['later', 'fail', true],
        ['resolves.toBe 1', 'pass', true],
        ['toBe 4', 'fail', true],
      ],
    )
    const soft = rawAssertions(t).filter((x) => x.status === 'fail')
    assert.equal(soft.length, 3)
    assert.ok(soft.every((x) => x.error instanceof Error))
    assert.match(checkFailure(rawAssertions(t))?.message ?? '', /first: expected 1 to be 2/)
  })

  test("a matcher that can't answer is an error, not a failure; a thrown non-Error keeps its text", () => {
    extendExpect({
      toBeReported: () => {
        throw new TypeError('toBeReported() expects a turn')
      },
      toBeAnswered: () => {
        const error = new Error("the harness doesn't report it")
        error.name = 'HarnessCapabilityError'
        throw error
      },
      toThrowNull: () => {
        throw null
      },
      toThrowText: () => {
        throw 'plain text'
      },
    })
    const t = task()
    const own = createExpect(t) as unknown as (
      value: unknown,
    ) => Record<'toBeReported' | 'toBeAnswered' | 'toThrowNull' | 'toThrowText', () => void>
    assert.throws(() => own(1).toBeReported(), TypeError)
    assert.throws(() => own(1).toBeAnswered(), /doesn't report/)
    assert.throws(() => own(1).toThrowNull())
    assert.throws(() => own(1).toThrowText())
    assert.deepEqual(
      records(t).map((x) => [x.status, x.message]),
      [
        ['error', 'toBeReported() expects a turn'],
        ['error', "the harness doesn't report it"],
        ['fail', 'null'],
        ['fail', 'plain text'],
      ],
    )
  })

  test('default labels: the first argument, or what the subject names; repeats are numbered', async () => {
    const t = task()
    const own = createExpect(t)
    const long = 'x'.repeat(80)
    own(long).toBe(long)
    own(/a/).toEqual(/a/)
    own({ a: 1 }).toEqual({ a: 1 })
    own(undefined).toBe(undefined)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    own(circular).toBe(circular)
    own(1n).toBe(1n)
    await own(named(Promise.resolve(1), 'npm   test\n')).resolves.toBeTruthy()
    own(named({ ok: true }, 'Is it ok?')).toBeTruthy()
    own(named(() => 1, 7)).toBeTruthy()
    own(1).toBeTruthy()
    own(null).toBeNull()
    for (const n of [1, 2, 3]) own(n).toBeTypeOf('number')
    assert.deepEqual(
      records(t).map((x) => x.label),
      [
        `toBe ${'x'.repeat(55)}…`,
        'toEqual /a/',
        'toEqual {"a":1}',
        'toBe undefined',
        'toBe [object Object]',
        'toBe 1',
        'resolves.toBeTruthy npm test',
        'toBeTruthy Is it ok?',
        'toBeTruthy',
        'toBeTruthy #2',
        'toBeNull',
        'toBeTypeOf number',
        'toBeTypeOf number #2',
        'toBeTypeOf number #3',
      ],
    )
  })

  test('an async matcher still running is left out until it settles', async () => {
    const t = task()
    const own = createExpect(t)
    let resolve = (_: number) => {}
    const late = own(new Promise<number>((r) => (resolve = r))).resolves.toBe(1)
    assert.deepEqual(records(t), [])
    resolve(1)
    await late
    assert.deepEqual(
      records(t).map((x) => x.label),
      ['resolves.toBe 1'],
    )
    // An expect without an attempt records nothing, and a task it never saw has nothing.
    createExpect()(1).toBe(1)
    assert.deepEqual(records(task()), [])
  })

  test('expect.poll is one entry with its final outcome, not one per try', async () => {
    const t = task()
    const own = createExpect(t)
    let n = 0
    await own.poll(() => ++n, { interval: 5, timeout: 1000 }).toBe(3)
    await assert.rejects(
      () =>
        own.poll(() => 'no', { interval: 5, timeout: 30, message: 'ready' }).toBe('yes') as never,
    )
    assert.deepEqual(
      records(t).map((x) => [x.label, x.matcher, x.status]),
      [
        ['poll.toBe 3', 'poll.toBe', 'pass'],
        ['ready', 'poll.toBe', 'fail'],
      ],
    )
    assert.ok((records(t)[0]?.durationMs ?? -1) >= 0)
  })

  test("a check in expect.poll's function counts on the try the poll ends on, not the ones it retried", async () => {
    const t = task()
    const own = createExpect(t)
    let n = 0
    await own
      .poll(
        () => {
          n++
          own.soft(n, 'soft inner').toBeGreaterThan(1)
          own(n, 'inner').toBeGreaterThan(2)
          return n
        },
        { interval: 5, timeout: 1000 },
      )
      .toBe(3)
    let m = 0
    const outer = async () => {
      m++
      await own.poll(() => m, { interval: 5, timeout: 1000, message: 'nested' }).toBeGreaterThan(0)
      return m
    }
    await own.poll(outer, { interval: 5, timeout: 1000 }).toBe(2)
    const inner = () =>
      own.poll(() => 'no', { interval: 5, timeout: 20, message: 'inner gave up' }).toBe('yes')
    await assert.rejects(
      () =>
        own
          .poll(inner, { interval: 5, timeout: 30, message: 'outer gave up' })
          .toBe(undefined) as never,
    )
    await assert.rejects(
      () =>
        own
          .poll(
            () => {
              own('no', 'last').toBe('yes')
            },
            { interval: 5, timeout: 30, message: 'gave up' },
          )
          .toBe(1) as never,
    )
    assert.deepEqual(
      records(t).map((x) => [x.label, x.status]),
      [
        ['poll.toBe 3', 'pass'],
        ['soft inner', 'pass'],
        ['inner', 'pass'],
        ['poll.toBe 2', 'pass'],
        ['nested', 'pass'],
        ['outer gave up', 'fail'],
        ['inner gave up', 'fail'],
        ['gave up', 'fail'],
        ['last', 'fail'],
      ],
    )
  })
})

describe('expect routed to the attempt', () => {
  test("inside an attempt, expect is the attempt's own and its async matchers are tracked", async () => {
    const t = task()
    const own = createExpect(t)
    const pending: Pending[] = []
    await withAttemptExpect(own, pending, async () => {
      expect(1).toBe(1)
      assert.equal(expect.getState().assertionCalls, 1)
      assert.equal(typeof expect.not, 'object', 'non-function properties pass through')
      void expect(Promise.resolve(1)).resolves.toBe(1)
      await expect(Promise.resolve(2)).resolves.toBe(2)
      expect.soft(1).toBe(2)
      void expect.poll(() => 1, { interval: 5, timeout: 20 }).toBe(1)
      assert.equal(expect.any(Number).asymmetricMatch(1), true)
    })
    assert.equal(own.getState().assertionCalls, 5)
    assert.deepEqual(
      pending.map((p) => [p.assertion, p.observed]),
      [
        ['expect(…).resolves.toBe()', false],
        ['expect(…).resolves.toBe()', true],
        ['expect.poll(…).toBe()', false],
      ],
    )
    assert.match(checkFailure(rawAssertions(t))?.message ?? '', /expected 1 to be 2/)
    // Outside any attempt, nothing is tracked and the worker's expect counts.
    const before = pending.length
    void expect(Promise.resolve(1)).resolves.toBe(1)
    assert.equal(pending.length, before)
  })

  test('a tracked thenable knows it was observed through then, catch or finally', async () => {
    const pending: Pending[] = []
    await withAttemptExpect(createExpect(task()), pending, async () => {
      await (expect(Promise.resolve(1)).resolves.toBe(1) as unknown as Promise<void>).catch(
        () => {},
      )
      await (expect(Promise.resolve(1)).resolves.toBe(1) as unknown as Promise<void>).finally(
        () => {},
      )
      const chain = expect(Promise.resolve(1)).resolves
      assert.equal(typeof chain.then, 'undefined', 'a chain is not itself a thenable')
      assert.equal(
        String(
          (expect(Promise.resolve(1)).resolves.toBe(1) as object)[Symbol.toStringTag as never],
        ),
        'Promise',
      )
    })
    assert.deepEqual(
      pending.map((p) => p.observed),
      [true, true, false],
    )
  })

  test('values that are already promises pass through a tracked chain untouched', async () => {
    const pending: Pending[] = []
    const thenable = Promise.resolve('x')
    await withAttemptExpect(createExpect(task()), pending, async () => {
      const assertion = expect(1) as unknown as Record<string, unknown>
      Object.defineProperty(assertion, 'promiseLike', { value: thenable })
      assert.equal(assertion.promiseLike, thenable)
    })
  })
})

describe('unawaited assertions', () => {
  const pendingOf = (outcome: Promise<unknown>, observed = false): Pending => ({
    assertion: 'expect(…).toHaveFile()',
    settled: outcome.then(
      () => undefined,
      (error: unknown) => error ?? new Error('failed'),
    ),
    observed,
  })

  test('nothing missed is no error', async () => {
    assert.equal(await unawaitedError([]), undefined)
    assert.equal(await unawaitedError([pendingOf(Promise.resolve(), true)]), undefined)
  })

  test("a missed assertion that passed still fails, saying it wasn't awaited", async () => {
    const missed = [pendingOf(Promise.resolve())]
    const error = await unawaitedError(missed)
    assert.equal(error?.name, 'AssertionError')
    assert.equal(
      error?.message,
      "expect(…).toHaveFile() wasn't awaited. Its check is async: write `await expect(…).toHaveFile()`.",
    )
    assert.equal(missed[0]?.observed, true)
    assert.equal(await unawaitedError(missed), undefined, 'each is reported once')
  })

  test('a missed assertion that failed reports its own failure with the hint', async () => {
    const error = await unawaitedError([
      pendingOf(Promise.resolve()),
      pendingOf(Promise.reject(new Error('expected file a.txt to exist'))),
    ])
    assert.match(
      error?.message ?? '',
      /^expected file a\.txt to exist\n\nexpect\(…\)\.toHaveFile\(\) wasn't awaited/,
    )
  })

  test("the hint names the eval's line, and the error's stack is where the eval called it", async () => {
    const file = join(process.cwd(), 'evals', 'build.eval.ts')
    const site = [
      'Error',
      '    at tracked (/pkg/dist/expect.js:1:1)',
      '    at <anonymous>',
      `    at file://${pathToFileURL(join(process.cwd(), 'evals', 'other.ts')).pathname}:3:1`,
      `    at ${pathToFileURL(file).href}:12:5`,
    ].join('\n')
    const hint =
      "expect(…).toHaveFile() at evals/build.eval.ts:12 wasn't awaited. Its check is async: write `await expect(…).toHaveFile()`."
    const missed = (): Pending[] => [{ ...pendingOf(Promise.resolve()), site }]
    const error = await unawaitedError(missed(), file)
    assert.equal(error?.message, hint)
    assert.equal(error?.stack, `AssertionError: ${hint}\n${site.split('\n').slice(1).join('\n')}`)
    const byUrl = await unawaitedError(missed(), pathToFileURL(file).href)
    assert.equal(byUrl?.message, hint)
    const elsewhere = await unawaitedError(missed(), join(process.cwd(), 'evals', 'x.eval.ts'))
    assert.match(elsewhere?.message ?? '', /^expect\(…\)\.toHaveFile\(\) wasn't awaited/)
    const unknown = await unawaitedError([pendingOf(Promise.resolve())], file)
    assert.match(unknown?.message ?? '', /^expect\(…\)\.toHaveFile\(\) wasn't awaited/)
  })

  test('a tracked matcher keeps the stack it was called from', async () => {
    const pending: Pending[] = []
    await withAttemptExpect(createExpect(task()), pending, async () => {
      await expect(Promise.resolve(1)).resolves.toBe(1)
    })
    assert.match(pending[0]?.site ?? '', /engine-expect\.test\.ts:\d+:\d+/)
  })

  test('a failure that is not an Error gets the hint alone', async () => {
    const error = await unawaitedError([pendingOf(Promise.reject('plain'))])
    assert.match(error?.message ?? '', /^expect\(…\)\.toHaveFile\(\) wasn't awaited/)
    const empty = await unawaitedError([pendingOf(Promise.reject(undefined))])
    assert.match(empty?.message ?? '', /^failed\n\n/)
  })
})
