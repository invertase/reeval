// What evaluate, group and an attempt reach of the engine (engine/runtime.ts): the engine the
// worker installed, or a clear error outside es run.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectingFile,
  type Engine,
  getRunContext,
  registerGroup,
  registerTest,
  useEngine,
} from '../src/engine/runtime.ts'
import type { RunContext } from '../src/types.ts'

test('outside es run, declaring an eval says how to run it; inside, calls reach the engine', () => {
  assert.throws(
    () => getRunContext(),
    (e: Error) =>
      e.name === 'UsageError' &&
      e.message ===
        'evaluate() and group() only work in an eval file that es run loads. Run it with es run.',
  )
  const calls: string[] = []
  const run = { runId: 'r' } as unknown as RunContext
  const engine: Engine = {
    registerTest: (name) => void calls.push(`test ${name}`),
    registerGroup: (name) => void calls.push(`group ${name}`),
    getRunContext: () => run,
    collectingFile: () => '/f.es.ts',
  }
  useEngine(engine)
  registerTest('t', { mode: 'run' }, async () => {})
  registerGroup('g', 'run', () => {})
  assert.deepEqual(calls, ['test t', 'group g'])
  assert.equal(getRunContext(), run)
  assert.equal(collectingFile(), '/f.es.ts')
})
