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
  type Limits,
  type PathMatch,
  type Result,
  type RunMatch,
  ran,
  searched,
  subjectError,
  type ToolInputMatch,
  withinLimits,
} from './assert.ts'
import { isObjectLike, isThenable } from './object.ts'
import { redactSecrets } from './redact.ts'
import { plural } from './text.ts'
import type {
  CapturePage,
  Diff,
  ExecResult,
  FileChange,
  JudgeFailure,
  StatusRange,
  Verdict,
} from './types.ts'
import { splitPatch } from './view/patch.ts'

/** Last file-matcher extras for the Chai/vitest path to copy onto the raw assertion. */
let pendingFileMeta: { target?: string; preSatisfied?: boolean } | undefined

/** Takes and clears extras the last `toHaveFile` put on its `Result`. */
export function takeFileMeta(): { target?: string; preSatisfied?: boolean } | undefined {
  const meta = pendingFileMeta
  pendingFileMeta = undefined
  return meta
}

function fileTarget(path: string, pattern?: RegExp | string): string {
  if (pattern === undefined) return path
  return `${path} ${typeof pattern === 'string' ? pattern : pattern.source}`
}

function subjectDiff(actual: unknown): Diff | null {
  if (isObjectLike(actual) && isObjectLike(actual.diff) && typeof actual.diff.patch === 'string') {
    return actual.diff as Diff
  }
  if (isObjectLike(actual) && Array.isArray(actual.turns) && actual.turns.length) {
    const last = actual.turns[actual.turns.length - 1]
    if (isObjectLike(last) && isObjectLike(last.diff) && typeof last.diff.patch === 'string') {
      return last.diff as Diff
    }
  }
  return null
}

function pathInDiff(files: FileChange[] | undefined, path: string): boolean {
  return (files ?? []).some((f) => f.path === path)
}

function preSatisfiedFile(
  actual: unknown,
  path: string,
  pattern: RegExp | string | undefined,
  not: boolean,
): true | undefined {
  const diff = subjectDiff(actual)
  const inDiff = pathInDiff(diff?.files, path)
  if (not) return inDiff ? undefined : true
  if (!inDiff) return true
  if (pattern === undefined || !diff?.patch) return undefined
  const section = splitPatch(diff.patch).find((p) => p.path === path)
  if (!section) return true
  const added = section.text
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
  const matched =
    typeof pattern === 'string'
      ? added.includes(pattern)
      : new RegExp(pattern.source, pattern.flags).test(added)
  return matched ? undefined : true
}

/** At least one of `T`'s keys. */
export type AtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<T> }[keyof T]

/** How the matcher was called: `not` is `expect(…).not`, which a matcher may answer itself. */
export type MatcherFlags = { not: boolean }

/** A matcher's body: the subject `expect` was given, then the matcher's own arguments. */
type Run<A extends unknown[], R extends Result | Promise<Result>> = (
  actual: unknown,
  args: A,
  flags: MatcherFlags,
) => R

const matcher = <A extends unknown[], R extends Result | Promise<Result>>(run: Run<A, R>) => run

/**
 * The last `lines` lines, and at most `chars` characters of them: one line can be megabytes.
 * Masked first, so a secret the cut would go through is masked whole.
 */
const tail = (s: string, lines = 20, chars = 2000) => {
  const last = redactSecrets(s).trimEnd().split('\n').slice(-lines).join('\n')
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
  if (typeof r?.exitCode !== 'number') throw subjectError('toSucceed() expects a c.exec() result')
  return {
    pass: r.exitCode === 0,
    message: () =>
      r.exitCode === 0
        ? 'expected command to fail'
        : `expected command to succeed, exit code ${r.exitCode}\n` +
          `--- stderr ---\n${tail(r.stderr)}\n--- stdout ---\n${tail(r.stdout)}`,
  }
}

const isCapture = (value: unknown): value is CapturePage & { name?: string } =>
  isObjectLike(value) &&
  typeof value.finalUrl === 'string' &&
  Array.isArray(value.errors) &&
  Array.isArray(value.console)

/** `capture "home" at /login`, or the URL alone for a capture with no name. */
const captureAt = (c: CapturePage & { name?: string }) =>
  typeof c.name === 'string' ? `capture "${c.name}" at ${c.finalUrl}` : c.finalUrl

/** The first errors, each cut to its message and first frames; the rest counted. */
const firstErrors = (c: CapturePage & { name?: string }, max = 5) => {
  const shown = c.errors
    .slice(0, max)
    .map((e) => tail(e.split('\n').slice(0, 4).join('\n'), 4, 600))
  const rest = c.errors.length - shown.length
  const file = typeof c.name === 'string' ? ` in ${c.name}.capture.json` : ''
  return [...shown, ...(rest > 0 ? [`… ${rest} more${file}`] : [])].join('\n')
}

/** What `toPass()` and `.not.toPass()` fail with on a judge call that answered nothing. */
export const judgeFailedMessage = (f: Pick<JudgeFailure, 'question' | 'model' | 'error'>) =>
  `judge failed for "${f.question}" (${f.model}): ${f.error}`

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
    async (actual, [path, pattern]: [path: string, pattern?: RegExp | string], flags) => {
      if (!hasFiles(actual)) throw subjectError('toHaveFile() expects a turn from c.send(), or c')
      const target = fileTarget(path, pattern)
      const content = await actual.readFile(path)
      let pass: boolean
      let message: () => string
      if (content === null) {
        pass = false
        message = () => `expected file ${path} to exist`
      } else if (pattern === undefined) {
        pass = true
        message = () => `expected no file at ${path}`
      } else {
        pass = typeof pattern === 'string' ? content.includes(pattern) : pattern.test(content)
        message = () =>
          `expected ${path} ${pass ? 'not ' : ''}to match ${pattern}\n--- ${path} ---\n${tail(content)}`
      }
      const assertionPassed = flags.not ? !pass : pass
      const preSatisfied = assertionPassed
        ? preSatisfiedFile(actual, path, pattern, flags.not)
        : undefined
      const result: Result = {
        pass,
        message,
        target,
        ...(preSatisfied ? { preSatisfied: true } : {}),
      }
      pendingFileMeta = { target, ...(preSatisfied ? { preSatisfied: true } : {}) }
      return result
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

  toHaveRun: matcher((actual, [command]: [command?: RegExp | string | RunMatch]) =>
    ran(actual, command),
  ),

  toHaveEdited: matcher((actual, [path]: [path?: RegExp | string]) => edited(actual, path)),

  toHaveChanged: matcher((actual, [paths]: [paths?: PathMatch]) => changed(actual, paths)),

  toStayWithin: matcher((actual, [limits]: [limits: AtLeastOne<Limits>], { not }) =>
    withinLimits(actual, limits, not),
  ),

  toHaveStatus: matcher((actual, [status]: [status: number | StatusRange]): Result => {
    if (!isCapture(actual)) throw subjectError('toHaveStatus() expects a c.capture() result')
    const range = typeof status === 'string' && /^[1-5]xx$/.test(status) ? Number(status[0]) : 0
    const code =
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    if (!range && !code) {
      throw subjectError(
        `toHaveStatus() expects a status from 100 to 599 or a range from '1xx' to '5xx', got ${JSON.stringify(status)}`,
      )
    }
    const pass =
      actual.status !== undefined &&
      (range ? Math.floor(actual.status / 100) === range : actual.status === status)
    return {
      pass,
      message: () =>
        pass
          ? `expected ${captureAt(actual)} not to answer ${status}`
          : actual.status === undefined
            ? `expected ${captureAt(actual)} to answer ${status}, but no response came`
            : `expected ${captureAt(actual)} to answer ${status}, got ${actual.status}`,
    }
  }),

  toHaveNoPageErrors: matcher((actual, _: []): Result => {
    if (!isCapture(actual)) throw subjectError('toHaveNoPageErrors() expects a c.capture() result')
    const pass = actual.errors.length === 0
    return {
      pass,
      message: () =>
        pass
          ? `expected ${captureAt(actual)} to have page errors`
          : `expected no page errors at ${captureAt(actual)}, got ${plural(actual.errors.length, 'page error')}: ${firstErrors(actual)}`,
    }
  }),

  toPass: matcher((actual, _: [], { not }): Result => {
    const failure = actual as JudgeFailure
    if (failure?.verdict === 'error' && typeof failure.error === 'string') {
      // A failed call answered nothing, so `.not.toPass()` fails on it too.
      return { pass: not, message: () => judgeFailedMessage(failure) }
    }
    const v = actual as Verdict
    if (typeof v?.score !== 'number') throw subjectError('toPass() expects a c.judge() verdict')
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
