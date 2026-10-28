// reeval's matchers, once: the Chai adapter `expect` extends with and the attempt protocol's
// `expect` call (attempt/match.ts) both run these, so a matcher's outcome and message are the same
// however it was called. engine/expect.ts's `Matchers` interface is held to this table.

import { isDeepStrictEqual } from 'node:util'
import {
  calledMcp,
  calledSkill,
  calledTool,
  changed,
  edited,
  fetched,
  type PathMatch,
  type Result,
  ran,
  searched,
  type ToolInputMatch,
} from './assert.ts'
import { isObjectLike, isThenable } from './object.ts'
import type { ExecResult, JudgeFailure, Verdict } from './types.ts'

/** How the matcher was called: `not` is `expect(…).not`, which a matcher may answer itself. */
export type MatcherFlags = { not: boolean }

/** A matcher's body: the subject `expect` was given, then the matcher's own arguments. */
type Run<A extends unknown[], R extends Result | Promise<Result>> = (
  actual: unknown,
  args: A,
  flags: MatcherFlags,
) => R

const matcher = <A extends unknown[], R extends Result | Promise<Result>>(run: Run<A, R>) => run

/** The last `lines` lines, and at most `chars` characters of them: one line can be megabytes. */
const tail = (s: string, lines = 20, chars = 2000) => {
  const last = s.trimEnd().split('\n').slice(-lines).join('\n')
  return last.length <= chars
    ? last
    : `[… ${last.length - chars} earlier characters]${last.slice(-chars)}`
}

type HasFiles = { readFile(path: string): Promise<string | null> }

const hasFiles = (value: unknown): value is HasFiles =>
  isObjectLike(value) && typeof value.readFile === 'function'

const show = (value: unknown): string => {
  if (typeof value === 'string') return `'${value}'`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function succeeded(actual: unknown): Result {
  const r = actual as ExecResult
  if (typeof r?.exitCode !== 'number') throw new TypeError('toSucceed() expects a c.exec() result')
  return {
    pass: r.exitCode === 0,
    message: () =>
      r.exitCode === 0
        ? 'expected command to fail'
        : `expected command to succeed, exit code ${r.exitCode}\n` +
          `--- stderr ---\n${tail(r.stderr)}\n--- stdout ---\n${tail(r.stdout)}`,
  }
}

export const MATCHERS = {
  toBe: matcher((actual, [expected]: [unknown]) => {
    const pass = Object.is(actual, expected)
    return {
      pass,
      message: () =>
        pass
          ? `expected ${show(actual)} not to be ${show(expected)} // Object.is equality`
          : `expected ${show(actual)} to be ${show(expected)} // Object.is equality`,
    }
  }),

  toEqual: matcher((actual, [expected]: [unknown]) => {
    const pass = isDeepStrictEqual(actual, expected)
    return {
      pass,
      message: () =>
        pass
          ? `expected ${show(actual)} not to deeply equal ${show(expected)}`
          : `expected ${show(actual)} to deeply equal ${show(expected)}`,
    }
  }),

  toBeNull: matcher((actual, _: []) => ({
    pass: actual === null,
    message: () =>
      actual === null
        ? `expected ${show(actual)} not to be null`
        : `expected ${show(actual)} to be null`,
  })),

  toBeTruthy: matcher((actual, _: []) => ({
    pass: !!actual,
    message: () =>
      actual ? `expected ${show(actual)} to be falsy` : `expected ${show(actual)} to be truthy`,
  })),

  toContain: matcher((actual, [needle]: [unknown]) => {
    const pass =
      typeof actual === 'string' && typeof needle === 'string'
        ? actual.includes(needle)
        : Array.isArray(actual) && actual.includes(needle)
    return {
      pass,
      message: () =>
        pass
          ? `expected ${show(actual)} not to contain ${show(needle)}`
          : `expected ${show(actual)} to contain ${show(needle)}`,
    }
  }),

  toHaveFile: matcher(
    async (actual, [path, pattern]: [path: string, pattern?: RegExp | string]) => {
      if (!hasFiles(actual)) throw new TypeError('toHaveFile() expects a turn from c.send(), or c')
      const content = await actual.readFile(path)
      if (content === null) return { pass: false, message: () => `expected file ${path} to exist` }
      if (pattern === undefined) return { pass: true, message: () => `expected no file at ${path}` }
      const pass = typeof pattern === 'string' ? content.includes(pattern) : pattern.test(content)
      return {
        pass,
        message: () =>
          `expected ${path} ${pass ? 'not ' : ''}to match ${pattern}\n--- ${path} ---\n${tail(content)}`,
      }
    },
  ),

  // Synchronous on a result; only `c.exec()`'s promise makes it async.
  toSucceed: matcher((actual, _: []): Result | Promise<Result> =>
    isThenable(actual) ? Promise.resolve(actual).then(succeeded) : succeeded(actual),
  ),

  toHaveSearched: matcher((actual, [query]: [query?: RegExp | string]) => searched(actual, query)),

  toHaveFetched: matcher((actual, [url]: [url?: RegExp | string]) => fetched(actual, url)),

  toHaveCalledSkill: matcher((actual, [name]: [name: string]) => calledSkill(actual, name)),

  toHaveCalledMcp: matcher(
    (actual, [server, tool, input]: [server: string, tool: string, input?: ToolInputMatch]) =>
      calledMcp(actual, server, tool, input),
  ),

  toHaveCalledTool: matcher(
    (actual, [name, input]: [name: string | RegExp, input?: ToolInputMatch]) =>
      calledTool(actual, name, input),
  ),

  toHaveRun: matcher((actual, [command]: [command?: RegExp | string]) => ran(actual, command)),

  toHaveEdited: matcher((actual, [path]: [path?: RegExp | string]) => edited(actual, path)),

  toHaveChanged: matcher((actual, [paths]: [paths?: PathMatch]) => changed(actual, paths)),

  toPass: matcher((actual, _: [], { not }): Result => {
    const failure = actual as JudgeFailure
    if (failure?.verdict === 'error' && typeof failure.error === 'string') {
      // A failed call answered nothing, so `.not.toPass()` fails on it too.
      return {
        pass: not,
        message: () =>
          `judge failed for "${failure.question}" (${failure.model}): ${failure.error}`,
      }
    }
    const v = actual as Verdict
    if (typeof v?.score !== 'number') throw new TypeError('toPass() expects a c.judge() verdict')
    const score = v.score.toFixed(2)
    return {
      pass: v.verdict === 'pass',
      message: () =>
        v.verdict === 'pass'
          ? `expected judge to fail: score ${score} ≥ ${v.threshold} for "${v.question}"`
          : `judge score ${score} is below ${v.threshold} for "${v.question}" (${v.model})`,
    }
  }),
}

export type MatcherName = keyof typeof MATCHERS

/** Vitest/Jest already ship these; the protocol table still runs them for Python and other SDKs. */
const GENERIC_MATCHERS = new Set<MatcherName>([
  'toBe',
  'toEqual',
  'toBeNull',
  'toBeTruthy',
  'toContain',
])

/** A matcher's arguments after the subject, as `expect(…).<name>(...args)` takes them. */
export type MatcherArgs<K extends MatcherName> = Parameters<(typeof MATCHERS)[K]>[1]

export const isMatcherName = (name: string): name is MatcherName => Object.hasOwn(MATCHERS, name)

/** Runs `name`'s row on arguments its signature hasn't checked, as Chai and the protocol pass them. */
export const runMatcher = (
  name: MatcherName,
  actual: unknown,
  args: unknown[],
  flags: MatcherFlags,
): Result | Promise<Result> =>
  (MATCHERS[name] as Run<unknown[], Result | Promise<Result>>)(actual, args, flags)

type ChaiMatcher<K extends MatcherName> = (
  this: { isNot?: boolean } | undefined,
  actual: unknown,
  ...args: MatcherArgs<K>
) => ReturnType<(typeof MATCHERS)[K]>

/** The table as `expect.extend` takes it: Chai passes `.not` as `this.isNot`. */
export const matchers = Object.fromEntries(
  (Object.keys(MATCHERS) as MatcherName[]).map((name) => [
    name,
    function (this: { isNot?: boolean } | undefined, actual: unknown, ...args: unknown[]) {
      return runMatcher(name, actual, args, { not: !!this?.isNot })
    },
  ]),
) as { [K in MatcherName]: ChaiMatcher<K> }

/** Chai `expect.extend` in eval workers: reeval-specific matchers only (not Jest's toEqual, …). */
export const evalMatchers = Object.fromEntries(
  (Object.keys(matchers) as MatcherName[])
    .filter((name) => !GENERIC_MATCHERS.has(name))
    .map((name) => [name, matchers[name]]),
) as typeof matchers
