// `expect`, from @vitest/expect's Chai plugins rather than Vitest's runner, and routed to the
// attempt that asserts: attempts run concurrently in one worker, so the assertion counts, the
// failures a check records and async assertions must reach the attempt that made them.
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import {
  ASYMMETRIC_MATCHERS_OBJECT,
  addCustomEqualityTesters,
  type ChaiPlugin,
  chai,
  customMatchers,
  type Matchers as ExpectMatchers,
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
import type { Limits } from '../assert.ts'
import { fromCwd } from '../ids.ts'
import type { AtLeastOne, MATCHERS, MatcherArgs, MatcherName } from '../matchers.ts'
import { isThenable } from '../object.ts'
import type {
  AttemptContext,
  CapturePage,
  ExecResult,
  JudgeFailure,
  StatusRange,
  Turn,
  Verdict,
} from '../types.ts'
import { comparable } from './errors.ts'
import { originalStack } from './loader.ts'

type TranscriptSubject = Pick<Turn, 'transcript' | 'unreported'> | Pick<AttemptContext, 'turns'>

/** The values each of reeval's own matchers takes as `expect`'s subject. */
type MatcherSubjects = {
  toHaveFile: { readFile(path: string): Promise<string | null> }
  toSucceed: ExecResult | PromiseLike<ExecResult>
  toPass: Verdict | JudgeFailure
  toHaveSearched: TranscriptSubject
  toHaveFetched: TranscriptSubject
  toHaveCalledSkill: TranscriptSubject
  toHaveCalledMcp: TranscriptSubject
  toHaveCalledTool: TranscriptSubject
  toHaveRun: TranscriptSubject
  toHaveEdited: TranscriptSubject
  toHaveChanged: Pick<Turn, 'diff'> | Pick<AttemptContext, 'turns'>
  toStayWithin: Pick<Turn, 'usage' | 'transcript' | 'durationMs'> | Pick<AttemptContext, 'turns'>
  toHaveStatus: CapturePage
  toHaveNoPageErrors: CapturePage
}

type TakesTurns<K extends string> = `${K}() takes c, or a turn from await c.send()`

/** What each matcher says, in the editor, about a subject it doesn't take. */
type SubjectHints = {
  toHaveFile: TakesTurns<'toHaveFile'>
  toSucceed: 'toSucceed() takes c.exec() or its awaited result'
  toPass: 'toPass() takes the verdict from await c.judge()'
  toHaveSearched: TakesTurns<'toHaveSearched'>
  toHaveFetched: TakesTurns<'toHaveFetched'>
  toHaveCalledSkill: TakesTurns<'toHaveCalledSkill'>
  toHaveCalledMcp: TakesTurns<'toHaveCalledMcp'>
  toHaveCalledTool: TakesTurns<'toHaveCalledTool'>
  toHaveRun: TakesTurns<'toHaveRun'>
  toHaveEdited: TakesTurns<'toHaveEdited'>
  toHaveChanged: TakesTurns<'toHaveChanged'>
  toStayWithin: TakesTurns<'toStayWithin'>
  toHaveStatus: 'toHaveStatus() takes the capture from await c.capture()'
  toHaveNoPageErrors: 'toHaveNoPageErrors() takes the capture from await c.capture()'
}

/**
 * A matcher called on a subject it doesn't take: not callable, and its one key, which the
 * compiler's error shows, says what it takes.
 */
export type WrongSubject<Hint extends string> = { readonly [K in Hint]: never }

/** `F` when `T` is a subject matcher `K` takes (or `any`, which can't be told), else its hint. */
type On<T, K extends keyof MatcherSubjects, F> = 0 extends 1 & T
  ? F
  : [T] extends [MatcherSubjects[K]]
    ? F
    : WrongSubject<SubjectHints[K]>

declare module '@vitest/expect' {
  interface ExpectPollOptions {
    interval?: number
    timeout?: number
    message?: string
  }
  interface ExpectStatic {
    assert: Chai.AssertStatic
    unreachable: (message?: string) => never
    /**
     * `expect` for a gate: a failed matcher ends the eval's body there, as a thrown error does,
     * where `expect` records the failure and carries on.
     */
    require: (<T>(actual: T, message?: string) => import('@vitest/expect').Assertion<void, T>) & {
      poll: ExpectStatic['poll']
    }
    poll: <T>(
      actual: (options: { signal: AbortSignal }) => T,
      options?: ExpectPollOptions,
    ) => import('@vitest/expect').Assertion<Promise<void>, Awaited<T>>
    addEqualityTesters: (testers: Array<Tester>) => void
    assertions: (expected: number) => void
    hasAssertions: () => void
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toBeNull(): void
    toBeTruthy(): void
    toContain(needle: unknown): void
    /** `c` or a turn has the file, matching `pattern` when given. Async: `await` it. */
    toHaveFile: On<T, 'toHaveFile', (path: string, pattern?: RegExp | string) => Promise<void>>
    /** The command exited 0. Async only on `c.exec()`'s promise; an awaited result is checked at once. */
    toSucceed: On<T, 'toSucceed', () => T extends PromiseLike<unknown> ? Promise<void> : R>
    toHaveSearched: On<T, 'toHaveSearched', (query?: RegExp | string) => R>
    toHaveFetched: On<T, 'toHaveFetched', (url?: RegExp | string) => R>
    toHaveCalledSkill: On<T, 'toHaveCalledSkill', (name: string) => R>
    toHaveCalledMcp: On<
      T,
      'toHaveCalledMcp',
      (server: string, tool: string, input?: string | RegExp | Record<string, unknown>) => R
    >
    toHaveCalledTool: On<
      T,
      'toHaveCalledTool',
      (name: string | RegExp, input?: string | RegExp | Record<string, unknown>) => R
    >
    toHaveRun: On<T, 'toHaveRun', (command?: RegExp | string) => R>
    toHaveEdited: On<T, 'toHaveEdited', (path?: RegExp | string) => R>
    toHaveChanged: On<
      T,
      'toHaveChanged',
      (paths?: string | RegExp | ReadonlyArray<string | RegExp>) => R
    >
    /**
     * The turn, or every turn of `c`, stayed within each limit: `tokens` (input and output,
     * subagents included), `toolCalls` (a count, or a count per tool) and `duration`. A turn
     * with no reported usage can't be checked against `tokens`, which is an error, not a failure.
     */
    toStayWithin: On<T, 'toStayWithin', (limits: AtLeastOne<Limits>) => R>
    /** The main frame's latest document answered `status`, after redirects. */
    toHaveStatus: On<T, 'toHaveStatus', (status: number | StatusRange) => R>
    /** The page had no uncaught exception or unhandled rejection. */
    toHaveNoPageErrors: On<T, 'toHaveNoPageErrors', () => R>
    /** The judge's verdict passed. */
    toPass: On<T, 'toPass', () => R>
  }
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Matcher `K` as `expect` offers it on a settled subject it takes. */
type Offered<K extends MatcherName> = ExpectMatchers<
  void,
  K extends keyof MatcherSubjects ? Exclude<MatcherSubjects[K], PromiseLike<unknown>> : unknown
>[K]

type Fn = (...args: never[]) => unknown

/** Each reeval matcher whose signature here differs from its row in MATCHERS. */
type MatcherDrift = {
  [K in MatcherName]: Offered<K> extends Fn
    ? Same<Parameters<Offered<K>>, MatcherArgs<K>> extends true
      ? Same<
          ReturnType<Offered<K>>,
          ReturnType<(typeof MATCHERS)[K]> extends Promise<unknown> ? Promise<void> : void
        > extends true
        ? never
        : K
      : K
    : K
}[MatcherName]
type _MatchersAsTable<T extends true = Same<MatcherDrift, never>> = T

export type { ExpectStatic }

chai.use(JestExtend as ChaiPlugin)
chai.use(JestChaiExpect as ChaiPlugin)
chai.use(JestAsymmetricMatchers as ChaiPlugin)

/** What the matchers read of the attempt, shaped like Vitest's test task. */
export type ExpectTask = {
  type: 'test'
  name: string
  fullTestName: string
  /** The eval file, whose line each matcher call records. */
  file?: string
}

type Extra = {
  expectedAssertionsNumber: number | null
  expectedAssertionsNumberErrorGen: (() => Error) | null
  isExpectingAssertions: boolean
  isExpectingAssertionsError: Error | null
}

/** One settled `expect` matcher call as the engine saw it; attempt/assertions.ts makes its record. */
export type RawAssertion = {
  /** `toHaveFile`, `not.toBe`, `resolves.toBe`, `poll.toBe`. */
  matcher: string
  args: unknown[]
  /** What the subject names itself by (its `SUBJECT`), if it does. */
  subject?: unknown
  /** `expect`'s second argument, when the eval gave one. */
  label?: string
  /** False for `expect.require`, whose failure ends the eval's body. */
  soft: boolean
  /** `path:line` of the call in the eval file, relative to the project root. */
  at?: string
  status: 'pass' | 'fail' | 'error'
  /** What the matcher threw, unless it passed. */
  error?: unknown
  /** Async matchers only. */
  durationMs?: number
}

/**
 * A value that names itself in a default label when its matcher takes no argument: `c.exec`'s
 * promise names its command, a judge verdict its question.
 */
export const SUBJECT = Symbol.for('reeval.subject')

type Recorded = Omit<RawAssertion, 'status'> & { status?: RawAssertion['status'] }

/**
 * The matcher calls one try of an `expect.poll` function made: a try the poll retries doesn't
 * count, so they leave the attempt's list, as the poll's own matcher records only its last try.
 */
const pollTry = new AsyncLocalStorage<Recorded[]>()

const recordings = new WeakMap<ExpectTask, Recorded[]>()
const ownRecordings = new WeakMap<ExpectStatic, Recorded[]>()

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

const flag = (assertion: object, name: string): unknown => chai.util.flag(assertion, name)

const subjectOf = (value: unknown): unknown =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
    ? (value as Record<symbol, unknown>)[SUBJECT]
    : undefined

/** Can't answer either way: the harness doesn't report it, or the subject isn't one it reads. */
export const isUnanswerable = (error: unknown) =>
  (error instanceof TypeError && Symbol.for('reeval.subjectError') in error) ||
  (error as Error | null)?.name === 'HarnessCapabilityError'

/** A matcher called wrong (reeval's `misuseError`): no check ran, so none is recorded. */
const isMisuse = (error: unknown) =>
  error instanceof TypeError && Symbol.for('reeval.misuse') in error

const unrecord = (list: Recorded[], entry: Recorded) => {
  for (const calls of [list, pollTry.getStore()]) {
    const at = calls?.indexOf(entry) ?? -1
    if (at >= 0) calls?.splice(at, 1)
  }
}

/** `path:line` of the first frame in `stack` that is in `file`, the eval file, when one is. */
export function lineIn(stack: string | undefined, file: string): string | undefined {
  const want = comparable(file.startsWith('file:') ? fileURLToPath(file) : file)
  const frames = originalStack(stack ?? '')
    .split('\n')
    .slice(1)
  for (const frame of frames) {
    // `at fn (path:line:col)` or `at path:line:col`; a path may have spaces and parentheses.
    const at = /\((.+):(\d+):\d+\)$|^at (?:async )?(.+):(\d+):\d+$/.exec(frame.trim())
    if (!at) continue
    const [, inCall, callLine, bare, bareLine] = at
    const found = (inCall ?? bare) as string
    const path = found.startsWith('file:') ? fileURLToPath(found) : found
    if (comparable(path) === want) return `${fromCwd(path)}:${callLine ?? bareLine}`
  }
  return undefined
}

/** Where the eval called the matcher, when it was called from `file`. */
function siteIn(file: string | undefined): string | undefined {
  if (!file) return undefined
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 50
  const stack = new Error().stack as string
  Error.stackTraceLimit = limit
  return lineIn(stack, file)
}

/** Starts a record of `matcher` called on `assertion`, in call order. */
function begin(
  list: Recorded[],
  assertion: object,
  name: string,
  args: unknown[],
  file: string | undefined,
): Recorded {
  const message = flag(assertion, 'message')
  const matcher = [
    flag(assertion, 'poll') && 'poll',
    flag(assertion, 'promise'),
    flag(assertion, 'negate') && 'not',
    name,
  ]
    .filter(Boolean)
    .join('.')
  const at = siteIn(file)
  const entry: Recorded = {
    matcher,
    args,
    subject: subjectOf(flag(assertion, 'object')),
    ...(typeof message === 'string' && message ? { label: message } : {}),
    soft: !flag(assertion, 'require'),
    ...(at ? { at } : {}),
  }
  list.push(entry)
  pollTry.getStore()?.push(entry)
  return entry
}

function settle(entry: Recorded, error: unknown, startedAt?: number) {
  entry.status = error === undefined ? 'pass' : isUnanswerable(error) ? 'error' : 'fail'
  if (error !== undefined) entry.error = error
  if (startedAt !== undefined) entry.durationMs = Math.round(performance.now() - startedAt)
}

/** What a matcher failed with when its subject didn't match, not an error raised under it. */
function isMatcherFailure(error: unknown): boolean {
  // `.resolves` on a promise that rejected: the rejection is the error.
  if (error instanceof chai.AssertionError) {
    const { cause } = error as { cause?: unknown }
    return !(cause instanceof Error) || isMatcherFailure(cause)
  }
  // A matcher from `expect.extend` (reeval's own among them) that returned `pass: false`.
  return error instanceof Error && '__vitest_error_context__' in error
}

/**
 * A matcher's own answer: its subject didn't match, or it can't answer for it. Any other error
 * (the sandbox gone, a command that couldn't start, the eval's own code throwing) ends the body.
 */
export const isCheckOutcome = (error: unknown) => isMatcherFailure(error) || isUnanswerable(error)

/**
 * Whether a failed check lets the body carry on: an `expect`'s own outcome, outside a poll's
 * function, where it throws so the poll tries again.
 */
const carriesOn = (entry: Recorded, error: unknown) =>
  entry.soft && pollTry.getStore() === undefined && isCheckOutcome(error)

/**
 * Wraps an assertion so each matcher called on it is recorded on the attempt. A failed matcher's
 * outcome is kept on its entry, which fails the attempt at its end, and the body carries on;
 * under `expect.require` it throws, ending the body.
 */
function recording<T extends object>(target: T, list: Recorded[], file?: string): T {
  const chained = (value: unknown) =>
    value instanceof chai.Assertion ? recording(value, list, file) : value
  const call = (fn: (...args: unknown[]) => unknown, name: string, args: unknown[]) => {
    // `expect.poll` retries the matcher; it records the final outcome itself.
    if (flag(target, 'poll')) return Reflect.apply(fn, target, args)
    const entry = begin(list, target, name, args, file)
    const startedAt = performance.now()
    let result: unknown
    try {
      result = Reflect.apply(fn, target, args)
    } catch (error) {
      if (isMisuse(error)) {
        unrecord(list, entry)
        throw error
      }
      settle(entry, error)
      if (!carriesOn(entry, error)) throw error
      // A Chai method (`include`) chains on, as it would have passing; a Jest matcher returns nothing.
      return /^to[A-Z]/.test(name) ? undefined : chained(target)
    }
    if (!isThenable(result)) {
      settle(entry, undefined)
      return chained(result)
    }
    const recorded: SoftFailure = {}
    const settled = Promise.resolve(result).then(
      (value) => {
        settle(entry, undefined, startedAt)
        return value
      },
      (error: unknown) => {
        settle(entry, error, startedAt)
        if (!carriesOn(entry, error)) throw error
        recorded.error = error
      },
    )
    softFailures.set(settled, recorded)
    return settled
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

/** The attempt's matcher calls that have settled, in call order. */
export const rawAssertions = (task: ExpectTask): RawAssertion[] =>
  (recordings.get(task) ?? []).filter((r): r is RawAssertion => r.status !== undefined)

/** An `expect` of its own for one attempt (or, without a task, the worker's). */
export function createExpect(task?: ExpectTask): ExpectStatic {
  const list: Recorded[] = []
  if (task) recordings.set(task, list)
  const expect = ((value: unknown, message?: string) => {
    const { assertionCalls } = getState(expect)
    setState({ assertionCalls: assertionCalls + 1 }, expect)
    const assertion = chai.expect(value, message) as unknown as { withTest(t: unknown): object }
    return task ? recording(assertion.withTest(task), list, task.file) : assertion
  }) as ExpectStatic
  if (task) ownRecordings.set(expect, list)
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
  const required = (value: unknown, message?: string) => {
    const assertion = expect(value, message)
    chai.util.flag(assertion, 'require', true)
    return assertion
  }
  expect.require = Object.assign(required as ExpectStatic['require'], {
    poll: createPoll(expect, task && list, task?.file, true),
  })
  expect.poll = createPoll(expect, task && list, task?.file, false)
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

/** A longer `setTimeout` or `AbortSignal.timeout` fires after 1 ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * `expect.poll(fn).matcher()`: calls `fn` and the matcher until the matcher passes, every
 * `interval` ms, for at most `timeout` ms, then fails with the last error: recorded, or thrown
 * when `required` or the error isn't the matcher's.
 */
function createPoll(
  expect: ExpectStatic,
  list: Recorded[] | undefined,
  file: string | undefined,
  required: boolean,
): ExpectStatic['poll'] {
  return (fn, options = {}) => {
    const { interval = 50, timeout = 1000, message } = options
    for (const [key, ms] of [
      ['timeout', timeout],
      ['interval', interval],
    ] as const) {
      if (ms > MAX_TIMER_MS) {
        throw new TypeError(
          `expect.poll's ${key} is at most 596h (${MAX_TIMER_MS}ms), the longest timer Node can set (got ${ms})`,
        )
      }
    }
    const assertion = expect(null, message) as unknown as Chai.Assertion
    chai.util.flag(assertion, 'poll', true)
    if (required) chai.util.flag(assertion, 'require', true)
    const proxy: object = new Proxy(assertion, {
      get(target, key, receiver) {
        const matcher = Reflect.get(target, key, receiver)
        if (typeof matcher !== 'function')
          return matcher instanceof chai.Assertion ? proxy : matcher
        return (...args: unknown[]) => {
          const location = new Error('expect.poll')
          const entry = list && begin(list, assertion, String(key), args, file)
          const startedAt = performance.now()
          // A poll inside another poll's function: its last try's calls belong to the outer try.
          const outer = pollTry.getStore()
          const recorded: SoftFailure = {}
          const polled = (async () => {
            const deadline = Date.now() + timeout
            const signal = AbortSignal.timeout(timeout)
            for (;;) {
              const tried: Recorded[] = []
              try {
                chai.util.flag(assertion, 'object', await pollTry.run(tried, () => fn({ signal })))
                const result = await Reflect.apply(matcher, assertion, args)
                if (entry) settle(entry, undefined, startedAt)
                outer?.push(...tried)
                return result
              } catch (error) {
                if (Date.now() + interval >= deadline) {
                  if (error instanceof Error && location.stack)
                    error.stack = location.stack.replace(location.message, error.message)
                  if (entry) settle(entry, error, startedAt)
                  outer?.push(...tried)
                  if (!entry?.soft || outer || !isCheckOutcome(error)) throw error
                  recorded.error = error
                  return undefined
                }
                for (const t of tried) list?.splice(list.indexOf(t), 1)
                await new Promise((resolve) => setTimeout(resolve, interval))
              }
            }
          })()
          softFailures.set(polled, recorded)
          return polled
        }
      },
    })
    return proxy as never
  }
}

/** The failure `expect.assertions` or `expect.hasAssertions` left on an attempt. */
export function attemptExpectError(expect: ExpectStatic): Error | undefined {
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
export type Pending = {
  assertion: string
  settled: Promise<unknown>
  observed: boolean
  /** Made where the eval called the matcher; its stack is read only when it wasn't awaited. */
  site?: Error
}
const currentPending = new AsyncLocalStorage<Pending[]>()

type SoftFailure = { error?: unknown }
/**
 * The failure each async `expect` recorded and resolved past, by the promise its matcher returned:
 * an eval that doesn't await it still learns why it failed.
 */
const softFailures = new WeakMap<object, SoftFailure>()

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
              () => softFailures.get(result)?.error,
              (error: unknown) => error ?? new Error(`${name}() failed`),
            ),
            observed: false,
            site: new Error(),
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
const CHAINS: Record<string, string> = { require: 'expect.require(…)', poll: 'expect.poll(…)' }

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
    const method = (...args: unknown[]) => {
      const result = Reflect.apply(value, bound, args)
      return chain ? track(result, chain) : result
    }
    if (property !== 'require') return method
    const poll = (bound as ExpectStatic).require.poll
    return Object.assign(method, {
      poll: (...args: Parameters<typeof poll>) =>
        track(Reflect.apply(poll, bound, args), 'expect.require.poll(…)'),
    })
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
 * The running attempt's matcher calls, which its record is made from: another language's runner
 * adds the calls its body made over the attempt protocol here.
 */
export function attemptRecordings(): RawAssertion[] {
  const own = currentExpect.getStore()
  const list = own && ownRecordings.get(own)
  if (!list) throw new Error('attemptRecordings() is only called inside an attempt')
  return list as RawAssertion[]
}

/**
 * Waits for the async assertions the eval started but didn't await, and returns the error that
 * fails the attempt: the first one's failure, or that it wasn't awaited, with the eval's line.
 */
export async function unawaitedError(
  pending: Pending[],
  file?: string,
): Promise<Error | undefined> {
  const missed = pending.filter((p) => !p.observed)
  if (missed.length === 0) return undefined
  for (const p of missed) p.observed = true
  const outcomes = await Promise.all(missed.map((p) => p.settled))
  const i = Math.max(
    0,
    outcomes.findIndex((o) => o !== undefined),
  )
  const site = missed[i]?.site?.stack
  const where = file && lineIn(site, file)
  const hint = `${missed[i]?.assertion}${where ? ` at ${where}` : ''} wasn't awaited. Its check is async: write \`await ${missed[i]?.assertion}\`.`
  const failure = outcomes[i]
  if (failure instanceof Error) {
    failure.message = `${failure.message}\n\n${hint}`
    return failure
  }
  const error = new Error(hint)
  error.name = 'AssertionError'
  if (site) error.stack = `AssertionError: ${hint}\n${site.split('\n').slice(1).join('\n')}`
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
