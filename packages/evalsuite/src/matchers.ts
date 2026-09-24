import type { ExecResult, Run, Verdict } from './types.ts'

type Result = { pass: boolean; message: () => string }

const tail = (s: string, lines = 20) => s.trimEnd().split('\n').slice(-lines).join('\n')

const isRun = (value: unknown): value is Run =>
  typeof value === 'object' && value !== null && 'readFile' in value && 'diff' in value

export const matchers = {
  async toHaveFile(actual: unknown, path: string, pattern?: RegExp | string): Promise<Result> {
    if (!isRun(actual)) throw new TypeError('toHaveFile() expects the Run returned by agent.run()')
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
    if (typeof v?.verdict !== 'string') throw new TypeError('toPass() expects a judge() verdict')
    return {
      pass: v.verdict === 'pass',
      message: () =>
        v.verdict === 'inconclusive'
          ? `judge was inconclusive: ${v.reason}`
          : `judge verdict ${v.verdict}: ${v.reason}`,
    }
  },
}
