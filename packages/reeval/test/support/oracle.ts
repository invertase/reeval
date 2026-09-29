import assert from 'node:assert/strict'
import type { RunRecord } from '../../src/history/types.ts'
import type { ErrorKind, Outcome } from '../../src/types.ts'
import type { CliRun } from '../helpers.ts'

export type EvalExpectation = {
  outcome: Outcome
  /** Every attempt id, exactly: an eval that silently didn't register or run fails this. */
  attempts: string[]
  /** For a failing eval: why the failing attempts failed. */
  error?: { kind: ErrorKind; message: RegExp }
  /**
   * Attempt ids that must pass with no error. With `error` set, every other attempt must match
   * it. A compare canary fails on the variant and leaves the ungated control clean.
   */
  clean?: string[]
}

export type RunExpectation = {
  code: number
  /** By eval name: exactly these evals, no more. */
  evals: Record<string, EvalExpectation>
}

/**
 * The outside check on a run, independent of what its evals assert: the exit code, which evals
 * ran, every attempt id and outcome, and for failures the error kind and message. A canary's
 * expectation is `fail` with kind `assertion`, which proves the fixture's check can fail.
 */
export function expectRun(cli: CliRun, run: RunRecord, expected: RunExpectation): void {
  const output = `${cli.stdout}\n${cli.stderr}`
  assert.equal(cli.code, expected.code, `exit code\n${output}`)
  assert.deepEqual(
    run.evals.map((e) => e.name).sort(),
    Object.keys(expected.evals).sort(),
    'the evals that ran',
  )
  for (const e of run.evals) {
    const want = expected.evals[e.name] as EvalExpectation
    const attempts = e.attempts.map((a) => ({ id: a.id, outcome: a.outcome, error: a.error }))
    const detail = `${e.name}: ${JSON.stringify(attempts, null, 2)}\n${output}`
    assert.equal(e.outcome, want.outcome, detail)
    assert.deepEqual(
      e.attempts.map((a) => a.id),
      want.attempts,
      detail,
    )
    for (const a of e.attempts) {
      if (!want.error || want.clean?.includes(a.id)) {
        assert.equal(a.error, null, detail)
        continue
      }
      assert.equal(a.error?.kind, want.error.kind, detail)
      assert.match(a.error?.message ?? '', want.error.message, detail)
    }
  }
}
