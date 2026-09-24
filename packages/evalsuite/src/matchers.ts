import type { ExecResult, Verdict } from './types.ts'

type Result = { pass: boolean; message: () => string }

const tail = (s: string, lines = 20) => s.trimEnd().split('\n').slice(-lines).join('\n')

type HasFiles = { readFile(path: string): Promise<string | null> }

const hasFiles = (value: unknown): value is HasFiles =>
  typeof value === 'object' && value !== null && typeof (value as HasFiles).readFile === 'function'

export const matchers = {
  async toHaveFile(actual: unknown, path: string, pattern?: RegExp | string): Promise<Result> {
    if (!hasFiles(actual)) throw new TypeError('toHaveFile() expects a turn from t.send(), or t')
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

  toPass(actual: unknown): Result {
    const v = actual as Verdict
    if (typeof v?.score !== 'number') throw new TypeError('toPass() expects a t.judge() verdict')
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
