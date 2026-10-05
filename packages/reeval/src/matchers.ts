import {
  calledSkill,
  calledTool,
  edited,
  fetched,
  ran,
  searched,
  type ToolInputMatch,
} from './assert.ts'
import type { ExecResult, JudgeFailure, Verdict } from './types.ts'

export { HarnessCapabilityError } from './assert.ts'

type Result = { pass: boolean; message: () => string }

/** The last `lines` lines, and at most `chars` characters of them: one line can be megabytes. */
const tail = (s: string, lines = 20, chars = 2000) => {
  const last = s.trimEnd().split('\n').slice(-lines).join('\n')
  return last.length <= chars
    ? last
    : `[… ${last.length - chars} earlier characters]${last.slice(-chars)}`
}

type HasFiles = { readFile(path: string): Promise<string | null> }

const hasFiles = (value: unknown): value is HasFiles =>
  typeof value === 'object' && value !== null && typeof (value as HasFiles).readFile === 'function'

export const matchers = {
  async toHaveFile(actual: unknown, path: string, pattern?: RegExp | string): Promise<Result> {
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

  async toSucceed(actual: unknown): Promise<Result> {
    const r = (await actual) as ExecResult
    if (typeof r?.exitCode !== 'number') throw new TypeError('toSucceed() expects run.exec(...)')
    return {
      pass: r.exitCode === 0,
      message: () =>
        r.exitCode === 0
          ? 'expected command to fail'
          : `expected command to succeed, exit code ${r.exitCode}\n` +
            `--- stderr ---\n${tail(r.stderr)}\n--- stdout ---\n${tail(r.stdout)}`,
    }
  },

  toHaveSearched(actual: unknown, query?: RegExp | string): Result {
    return searched(actual, query)
  },

  toHaveFetched(actual: unknown, url?: RegExp | string): Result {
    return fetched(actual, url)
  },

  toHaveCalledSkill(actual: unknown, name: string): Result {
    return calledSkill(actual, name)
  },

  toHaveCalledTool(actual: unknown, name: string | RegExp, input?: ToolInputMatch): Result {
    return calledTool(actual, name, input)
  },

  toHaveRun(actual: unknown, command?: RegExp | string): Result {
    return ran(actual, command)
  },

  toHaveEdited(actual: unknown, path?: RegExp | string): Result {
    return edited(actual, path)
  },

  toPass(this: { isNot?: boolean } | undefined, actual: unknown): Result {
    const failure = actual as JudgeFailure
    if (failure?.verdict === 'error' && typeof failure.error === 'string') {
      // A failed call answered nothing, so `.not.toPass()` fails on it too.
      return {
        pass: !!this?.isNot,
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
  },
}
