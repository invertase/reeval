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
import { processError } from '@vitest/utils/error'
import type { AssertionRecord } from '../types.ts'

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

export type AssertionResult = AssertionRecord

/**
 * A value that names itself in a default label when its matcher takes no argument: `c.exec`'s
 * promise names its command, a judge verdict its question.
 */
export const SUBJECT = Symbol.for('reeval.subject')

type Recorded = Omit<AssertionResult, 'label' | 'status'> & {
  label: string | undefined
  status: AssertionResult['status'] | undefined
  args: unknown[]
  subject: unknown
}

const recordings = new WeakMap<ExpectTask, Recorded[]>()

/** Methods on an assertion that configure it or are Chai's plumbing, not checks. */
const UNRECORDED = new Set([
  'withContext',
  'withTest',
  'assert',
  'toString',
  'toJSON',
  'valueOf',
  'then',
  'catch',
  'finally',
])

const MESSAGE_LIMIT = 1024
const LABEL_LIMIT = 60

const clipped = (s: string, limit: number) => (s.length > limit ? `${s.slice(0, limit)}…` : s)

const flag = (assertion: object, name: string): unknown => chai.util.flag(assertion, name)

const subjectOf = (value: unknown): unknown =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
    ? (value as Record<symbol, unknown>)[SUBJECT]
    : undefined

/** Can't answer either way: the harness doesn't report it, or the subject isn't one it reads. */
const isUnanswerable = (error: unknown) =>
  error instanceof TypeError || (error as Error | null)?.name === 'HarnessCapabilityError'

/** Pushes a soft failure onto the task, as `@vitest/expect` does for `expect.soft`. */
function softFailure(task: ExpectTask, error: unknown) {
  task.result ??= { state: 'fail' }
  task.result.state = 'fail'
  task.result.errors ??= []
  task.result.errors.push(processError(error))
}

/** Starts a record of `matcher` called on `assertion`, in call order. */
function begin(list: Recorded[], assertion: object, name: string, args: unknown[]): Recorded {
  const message = flag(assertion, 'message')
  const matcher = [
    flag(assertion, 'poll') && 'poll',
    flag(assertion, 'promise'),
    flag(assertion, 'negate') && 'not',
    name,
  ]
    .filter(Boolean)
    .join('.')
  const entry: Recorded = {
    label: typeof message === 'string' && message ? message : undefined,
    labelled: typeof message === 'string' && message !== '',
    matcher,
    status: undefined,
    soft: !!flag(assertion, 'soft'),
    args,
    subject: subjectOf(flag(assertion, 'object')),
  }
  list.push(entry)
  return entry
}

function settle(entry: Recorded, error: unknown, startedAt?: number) {
  entry.status = error === undefined ? 'pass' : isUnanswerable(error) ? 'error' : 'fail'
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : String(error)
    entry.message = clipped(message, MESSAGE_LIMIT)
  }
  if (startedAt !== undefined) entry.durationMs = Math.round(performance.now() - startedAt)
}

/**
 * Wraps an assertion so each matcher called on it is recorded on the attempt. A soft matcher's
 * failure is caught here and pushed onto the task as `@vitest/expect` would, so its outcome is
 * known per call.
 */
function recording<T extends object>(target: T, list: Recorded[], task: ExpectTask): T {
  const chained = (value: unknown) =>
    value instanceof chai.Assertion ? recording(value, list, task) : value
  const call = (fn: (...args: unknown[]) => unknown, name: string, args: unknown[]) => {
    // `expect.poll` retries the matcher; it records the final outcome itself.
    if (flag(target, 'poll')) return Reflect.apply(fn, target, args)
    const entry = begin(list, target, name, args)
    if (entry.soft) chai.util.flag(target, 'soft', false)
    const startedAt = performance.now()
    let result: unknown
    try {
      result = Reflect.apply(fn, target, args)
    } catch (error) {
      settle(entry, error)
      if (entry.soft) return softFailure(task, error)
      throw error
    }
    if (!isThenable(result)) {
      settle(entry, undefined)
      return chained(result)
    }
    return Promise.resolve(result).then(
      (value) => {
        settle(entry, undefined, startedAt)
        return value
      },
      (error: unknown) => {
        settle(entry, error, startedAt)
        if (entry.soft) return softFailure(task, error)
        throw error
      },
    )
  }
  return new Proxy(target, {
    get(t, property) {
      const value: unknown = Reflect.get(t, property)
      if (typeof property === 'symbol' || UNRECORDED.has(property)) return value
      if (typeof value !== 'function') return chained(value)
      // A Chai chainable method (`include`, `length`) is a function with assertion properties.
      return new Proxy(value as (...args: unknown[]) => unknown, {
        apply: (fn, _this, args) => call(fn, property, args),
        get: (fn, key) => chained(Reflect.get(fn, key)),
      })
    },
  })
}

const shown = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof RegExp) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * The attempt's matcher calls that have settled, in call order. Without a label, one is
 * `<matcher> <first argument>` (or what the subject names); repeats get ` #2`, ` #3`.
 */
export function attemptAssertions(task: ExpectTask): AssertionResult[] {
  const seen = new Map<string, number>()
  return (recordings.get(task) ?? []).flatMap((r) => {
    if (r.status === undefined) return []
    const named = r.args.length ? shown(r.args[0]) : shownSubject(r.subject)
    const base =
      r.label ?? clipped(named === undefined ? r.matcher : `${r.matcher} ${named}`, LABEL_LIMIT)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const { args: _args, subject: _subject, ...rest } = r
    return [{ ...rest, label: n > 1 ? `${base} #${n}` : base, status: r.status }]
  })
}

const shownSubject = (subject: unknown) =>
  typeof subject === 'string' && subject ? subject.replace(/\s+/g, ' ').trim() : undefined

/** An `expect` of its own for one attempt (or, without a task, the worker's). */
export function createExpect(task?: ExpectTask): ExpectStatic {
  const list: Recorded[] = []
  if (task) recordings.set(task, list)
  const expect = ((value: unknown, message?: string) => {
    const { assertionCalls } = getState(expect)
    setState({ assertionCalls: assertionCalls + 1 }, expect)
    const assertion = chai.expect(value, message) as unknown as { withTest(t: unknown): object }
    return task ? recording(assertion.withTest(task), list, task) : assertion
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
  expect.poll = createPoll(expect, task && list)
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
function createPoll(expect: ExpectStatic, list?: Recorded[]): ExpectStatic['poll'] {
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
          const entry = list && begin(list, assertion, String(key), args)
          const startedAt = performance.now()
          return (async () => {
            const deadline = Date.now() + timeout
            const signal = AbortSignal.timeout(timeout)
            for (;;) {
              try {
                chai.util.flag(assertion, 'object', await fn({ signal }))
                const result = await Reflect.apply(matcher, assertion, args)
                if (entry) settle(entry, undefined, startedAt)
                return result
              } catch (error) {
                if (Date.now() + interval >= deadline) {
                  if (error instanceof Error && location.stack)
                    error.stack = location.stack.replace(location.message, error.message)
                  if (entry) settle(entry, error, startedAt)
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
