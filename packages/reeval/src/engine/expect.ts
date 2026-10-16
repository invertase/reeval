// `expect`, from @vitest/expect's Chai plugins rather than Vitest's runner, and routed to the
// attempt that asserts: attempts run concurrently in one worker, so the assertion counts,
// `expect.soft` failures and async assertions must reach the attempt that made them.
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ASYMMETRIC_MATCHERS_OBJECT,
  addCustomEqualityTesters,
  type ChaiPlugin,
  chai,
  customMatchers,
  type ExpectStatic,
  GLOBAL_EXPECT,
  getState,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  type MatcherState,
  setState,
  type Tester,
} from '@vitest/expect'

declare module '@vitest/expect' {
  interface ExpectPollOptions {
    interval?: number
    timeout?: number
    message?: string
  }
  interface ExpectStatic {
    assert: Chai.AssertStatic
    unreachable: (message?: string) => never
    soft: <T>(actual: T, message?: string) => import('@vitest/expect').Assertion<void, T>
    poll: <T>(
      actual: (options: { signal: AbortSignal }) => T,
      options?: ExpectPollOptions,
    ) => import('@vitest/expect').Assertion<Promise<void>, Awaited<T>>
    addEqualityTesters: (testers: Array<Tester>) => void
    assertions: (expected: number) => void
    hasAssertions: () => void
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveFile(path: string, pattern?: RegExp | string): Promise<void>
    toSucceed(): Promise<void>
    toHaveSearched(query?: RegExp | string): void
    toHaveFetched(url?: RegExp | string): void
    toHaveCalledSkill(name: string): void
    toHaveCalledMcp(
      server: string,
      tool: string,
      input?: string | RegExp | Record<string, unknown>,
    ): void
    toHaveCalledTool(name: string | RegExp, input?: string | RegExp | Record<string, unknown>): void
    toHaveRun(command?: RegExp | string): void
    toHaveEdited(path?: RegExp | string): void
    toHaveChanged(paths?: string | RegExp | ReadonlyArray<string | RegExp>): void
    toPass(): void
  }
}

export type { ExpectStatic }

chai.use(JestExtend as ChaiPlugin)
chai.use(JestChaiExpect as ChaiPlugin)
chai.use(JestAsymmetricMatchers as ChaiPlugin)

/** What `expect.soft` and the matchers read of the attempt, shaped like Vitest's test task. */
export type ExpectTask = {
  type: 'test'
  name: string
  fullTestName: string
  result?: { state: string; errors?: unknown[] }
}

type Extra = {
  expectedAssertionsNumber: number | null
  expectedAssertionsNumberErrorGen: (() => Error) | null
  isExpectingAssertions: boolean
  isExpectingAssertionsError: Error | null
}

/** An `expect` of its own for one attempt (or, without a task, the worker's). */
export function createExpect(task?: ExpectTask): ExpectStatic {
  const expect = ((value: unknown, message?: string) => {
    const { assertionCalls } = getState(expect)
    setState({ assertionCalls: assertionCalls + 1 }, expect)
    const assertion = chai.expect(value, message) as unknown as { withTest(t: unknown): unknown }
    return task ? assertion.withTest(task) : assertion
  }) as ExpectStatic
  Object.assign(expect, chai.expect)
  Object.assign(expect, (globalThis as Record<symbol, object>)[ASYMMETRIC_MATCHERS_OBJECT])
  expect.getState = () => getState<MatcherState>(expect)
  expect.setState = (state) => setState(state, expect)
  setState<MatcherState & Extra>(
    {
      assertionCalls: 0,
      isExpectingAssertions: false,
      isExpectingAssertionsError: null,
      expectedAssertionsNumber: null,
      expectedAssertionsNumberErrorGen: null,
      currentTestName: task?.fullTestName ?? '',
    } as Partial<MatcherState & Extra>,
    expect,
  )
  expect.assert = chai.assert
  expect.extend = (matchers) =>
    (chai.expect as unknown as { extend: (e: ExpectStatic, m: unknown) => void }).extend(
      expect,
      matchers,
    )
  expect.addEqualityTesters = (testers) => addCustomEqualityTesters(testers)
  expect.soft = (value, message) =>
    (expect(value, message) as unknown as { withContext(c: object): never }).withContext({
      soft: true,
    })
  expect.poll = createPoll(expect)
  expect.unreachable = (message) => {
    chai.assert.fail(`expected${message ? ` "${message}" ` : ' '}not to be reached`)
  }
  function assertions(expected: number) {
    const errorGen = () =>
      new Error(
        `expected number of assertions to be ${expected}, but got ${expect.getState().assertionCalls}`,
      )
    setState<MatcherState & Extra>(
      { expectedAssertionsNumber: expected, expectedAssertionsNumberErrorGen: errorGen },
      expect,
    )
  }
  function hasAssertions() {
    const error = new Error('expected any number of assertion, but got none')
    setState<MatcherState & Extra>(
      { isExpectingAssertions: true, isExpectingAssertionsError: error },
      expect,
    )
  }
  chai.util.addMethod(expect, 'assertions', assertions)
  chai.util.addMethod(expect, 'hasAssertions', hasAssertions)
  expect.extend(customMatchers)
  return expect
}

/**
 * `expect.poll(fn).matcher()`: calls `fn` and the matcher until the matcher passes, every
 * `interval` ms, for at most `timeout` ms, then fails with the last error.
 */
function createPoll(expect: ExpectStatic): ExpectStatic['poll'] {
  return (fn, options = {}) => {
    const { interval = 50, timeout = 1000, message } = options
    const assertion = expect(null, message) as unknown as Chai.Assertion
    chai.util.flag(assertion, 'poll', true)
    const proxy: object = new Proxy(assertion, {
      get(target, key, receiver) {
        const matcher = Reflect.get(target, key, receiver)
        if (typeof matcher !== 'function')
          return matcher instanceof chai.Assertion ? proxy : matcher
        return (...args: unknown[]) => {
          const location = new Error('expect.poll')
          return (async () => {
            const deadline = Date.now() + timeout
            const signal = AbortSignal.timeout(timeout)
            for (;;) {
              try {
                chai.util.flag(assertion, 'object', await fn({ signal }))
                return await Reflect.apply(matcher, assertion, args)
              } catch (error) {
                if (Date.now() + interval >= deadline) {
                  if (error instanceof Error && location.stack)
                    error.stack = location.stack.replace(location.message, error.message)
                  throw error
                }
                await new Promise((resolve) => setTimeout(resolve, interval))
              }
            }
          })()
        }
      },
    })
    return proxy as never
  }
}

/** The failure `expect.assertions`, `expect.hasAssertions` or `expect.soft` left on an attempt. */
export function attemptExpectError(expect: ExpectStatic, task: ExpectTask): Error | undefined {
  const [soft] = task.result?.errors ?? []
  // Serialized by @vitest/expect; an Error again, so it fails the attempt like any other.
  if (soft) return Object.assign(new Error(), soft)
  const state = expect.getState() as MatcherState & Extra
  if (
    state.expectedAssertionsNumber !== null &&
    state.expectedAssertionsNumber !== state.assertionCalls
  )
    return (state.expectedAssertionsNumberErrorGen as () => Error)()
  if (state.isExpectingAssertions && state.assertionCalls === 0)
    return state.isExpectingAssertionsError as Error
  return undefined
}

const globalExpect = createExpect()
Object.defineProperty(globalThis, GLOBAL_EXPECT, {
  value: globalExpect,
  writable: true,
  configurable: true,
})

const currentExpect = new AsyncLocalStorage<ExpectStatic>()

/** An async assertion (`toHaveFile`, `toSucceed`, `.resolves`…) and whether the eval awaited it. */
export type Pending = { assertion: string; settled: Promise<unknown>; observed: boolean }
const currentPending = new AsyncLocalStorage<Pending[]>()

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Promise<unknown>).then === 'function'

/**
 * Wraps an assertion chain so each promise one of its matchers returns is tracked: an eval that
 * doesn't await it would otherwise pass and tear its sandbox down while the check still runs.
 */
function tracked<T extends object>(assertion: T, pending: Pending[], path: string): T {
  return new Proxy(assertion, {
    get(target, property) {
      const value = Reflect.get(target, property)
      const name = `${path}.${String(property)}`
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args)
          if (!isThenable(result)) return result
          const entry: Pending = {
            assertion: `${name}()`,
            settled: Promise.resolve(result).then(
              () => undefined,
              (error: unknown) => error ?? new Error(`${name}() failed`),
            ),
            observed: false,
          }
          pending.push(entry)
          const observe = <R>(fn: (p: Promise<unknown>) => R) => {
            entry.observed = true
            return fn(Promise.resolve(result))
          }
          return {
            // biome-ignore lint/suspicious/noThenProperty: a thenable that knows it was awaited
            then: (onFulfilled?: never, onRejected?: never) =>
              observe((p) => p.then(onFulfilled, onRejected)),
            catch: (onRejected?: never) => observe((p) => p.catch(onRejected)),
            finally: (onFinally?: never) => observe((p) => p.finally(onFinally)),
            [Symbol.toStringTag]: 'Promise',
          }
        }
      }
      return typeof value === 'object' && value !== null && !isThenable(value)
        ? tracked(value, pending, name)
        : value
    },
  })
}

const track = (assertion: unknown, path: string) => {
  const pending = currentPending.getStore()
  return pending && typeof assertion === 'object' && assertion !== null
    ? tracked(assertion, pending, path)
    : assertion
}

/** Assertions that return a chain, so the chain's async matchers are tracked too. */
const CHAINS: Record<string, string> = { soft: 'expect.soft(…)', poll: 'expect.poll(…)' }

export const expect: ExpectStatic = new Proxy(globalExpect, {
  apply: (target, thisArg, args) =>
    track(Reflect.apply(currentExpect.getStore() ?? target, thisArg, args), 'expect(…)'),
  get: (target, property) => {
    const bound = currentExpect.getStore() ?? target
    const value = Reflect.get(bound, property)
    // `expect.assert` is Chai's assert, a function with methods of its own.
    if (typeof value !== 'function' || property === 'assert') return value
    const chain = CHAINS[property as string]
    // Not `bind`: it reads `length`, which Chai's proxied methods reject.
    return (...args: unknown[]) => {
      const result = Reflect.apply(value, bound, args)
      return chain ? track(result, chain) : result
    }
  },
})

/** Runs an attempt's body with its own `expect` and unawaited-assertion list. */
export function withAttemptExpect<T>(
  own: ExpectStatic,
  pending: Pending[],
  body: () => Promise<T>,
): Promise<T> {
  return currentExpect.run(own, () => currentPending.run(pending, body))
}

/**
 * Waits for the async assertions the eval started but didn't await, and returns the error that
 * fails the attempt: the first one's failure, or that it wasn't awaited.
 */
export async function unawaitedError(pending: Pending[]): Promise<Error | undefined> {
  const missed = pending.filter((p) => !p.observed)
  if (missed.length === 0) return undefined
  for (const p of missed) p.observed = true
  const outcomes = await Promise.all(missed.map((p) => p.settled))
  const i = Math.max(
    0,
    outcomes.findIndex((o) => o !== undefined),
  )
  const hint = `${missed[i]?.assertion} wasn't awaited. Its check is async: write \`await ${missed[i]?.assertion}\`.`
  const failure = outcomes[i]
  if (failure instanceof Error) {
    failure.message = `${failure.message}\n\n${hint}`
    return failure
  }
  const error = new Error(hint)
  error.name = 'AssertionError'
  return error
}

type MatcherResult = { pass: boolean; message: () => string }
export type Matchers = Record<
  string,
  (actual: unknown, ...args: never[]) => MatcherResult | Promise<MatcherResult>
>

export function extendExpect(matchers: Matchers): void {
  globalExpect.extend(matchers as Parameters<ExpectStatic['extend']>[0])
}
