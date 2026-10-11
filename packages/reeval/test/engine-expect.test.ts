// The standalone `expect` (engine/expect.ts): Vitest's matchers from @vitest/expect, routed to the
// attempt that asserts, with reeval's shims for the runner state @vitest/expect expects.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  attemptExpectError,
  createExpect,
  type ExpectTask,
  expect,
  extendExpect,
  type Pending,
  unawaitedError,
  withAttemptExpect,
} from '../src/engine/expect.ts'

const task = (): ExpectTask => ({ type: 'test', name: 't', fullTestName: 'file > t' })
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
      attemptExpectError(own, t)?.message ?? '',
      /expected number of assertions to be 2, but got 1/,
    )
    own(2).toBe(2)
    assert.equal(attemptExpectError(own, t), undefined)
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
    assert.equal(
      attemptExpectError(own, t)?.message,
      'expected any number of assertion, but got none',
    )
    own(true).toBe(true)
    assert.equal(attemptExpectError(own, t), undefined)
  })

  test('expect.soft records a failure on the attempt and carries on', () => {
    const t = task()
    const own = createExpect(t)
    own.soft(1).toBe(2)
    own.soft(3).toBe(3)
    const error = attemptExpectError(own, t)
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
    assert.match(attemptExpectError(own, t)?.message ?? '', /expected 1 to be 2/)
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

  test('a failure that is not an Error gets the hint alone', async () => {
    const error = await unawaitedError([pendingOf(Promise.reject('plain'))])
    assert.match(error?.message ?? '', /^expect\(…\)\.toHaveFile\(\) wasn't awaited/)
    const empty = await unawaitedError([pendingOf(Promise.reject(undefined))])
    assert.match(empty?.message ?? '', /^failed\n\n/)
  })
})
