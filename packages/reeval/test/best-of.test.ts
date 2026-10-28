// `runs: { bestOf }` in the worker (src/best-of.ts): which side each attempt counts on, when a
// cell stops, and that a cell's later attempts wait for its earlier ones while other cells run.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bestOfCell, sideOf, undecided } from '../src/best-of.ts'
import { collect, registerTest } from '../src/engine/collector.ts'
import { runTests } from '../src/engine/run.ts'
import type { TestHandle } from '../src/engine/runtime.ts'
import type { EvalMeta } from '../src/types.ts'
import { tempDir } from './helpers.ts'

const meta = (outcome: string) => ({ outcome }) as unknown as EvalMeta

describe('best of', () => {
  test("an attempt counts on its record's side, else its state's; an infra error on neither", () => {
    assert.equal(sideOf({ state: 'passed' }), 'pass')
    assert.equal(sideOf({ state: 'failed' }), 'fail')
    assert.equal(sideOf({ state: 'skipped' }), null)
    assert.equal(sideOf({ state: 'passed', meta: meta('fail') }), 'fail')
    assert.equal(sideOf({ state: 'failed', meta: meta('infra_error') }), null)
  })

  test('a cell is undecided until one side has a majority', () => {
    assert.equal(undecided(['pass', 'fail'], 3), true)
    assert.equal(undecided(['pass', 'pass'], 3), false)
    assert.equal(undecided(['fail', 'fail', 'pass'], 5), true)
    assert.equal(undecided(['fail', 'fail', 'fail'], 5), false)
    assert.equal(undecided(['pass', null, 'pass'], 3), false)
    assert.equal(undecided(['pass', null, 'fail'], 5), true)
  })

  test('only the attempts past the majority wait, and each runs while the cell is undecided', async () => {
    const cell = bestOfCell(5)
    assert.equal(cell(1).ready, undefined)
    assert.equal(cell(3).ready, undefined)
    const fourth = cell(4).ready?.()
    const fifth = cell(5).ready?.()
    cell(1).settled?.({ state: 'passed' })
    cell(2).settled?.({ state: 'failed' })
    cell(3).settled?.({ state: 'failed', meta: meta('infra_error') })
    assert.equal(await fourth, true)
    cell(4).settled?.({ state: 'passed' })
    assert.equal(await fifth, true)

    const decided = bestOfCell(3)
    const third = decided(3).ready?.()
    decided(1).settled?.({ state: 'failed' })
    decided(2).settled?.({ state: 'failed' })
    assert.equal(await third, false)
  })

  test("a cell's later attempt starts after its earlier ones settle, while another cell runs", async () => {
    const order: string[] = []
    const gates: Record<string, () => void> = {}
    const body = (name: string, pass: boolean) => async (h: TestHandle) => {
      order.push(`start ${name}`)
      await new Promise<void>((resolve) => {
        gates[name] = resolve
      })
      h.setMeta(meta(pass ? 'pass' : 'fail'))
      order.push(`end ${name}`)
    }
    const a = bestOfCell(3)
    const b = bestOfCell(3)
    const collected = await collect('/f', async () => {
      registerTest('a1', { mode: 'run', ...a(1) }, body('a1', true))
      registerTest('a2', { mode: 'run', ...a(2) }, body('a2', false))
      registerTest('a3', { mode: 'run', ...a(3) }, body('a3', true))
      registerTest('b1', { mode: 'run', ...b(1) }, body('b1', true))
      registerTest('b2', { mode: 'run', ...b(2) }, body('b2', true))
      registerTest('b3', { mode: 'run', ...b(3) }, body('b3', true))
    })
    const states = new Map<number, string>()
    const running = runTests(collected, new Set([0, 1, 2, 3, 4, 5]), {
      file: '/f',
      stagingDir: tempDir('staging'),
      signal: new AbortController().signal,
      reporter: {
        start: () => {},
        progress: () => {},
        debug: () => {},
        log: () => {},
        result: (i, r) => void states.set(i, r.state),
        meta: () => {},
      },
      onReady: () => {},
    })
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    assert.deepEqual(order, ['start a1', 'start a2', 'start b1', 'start b2'])
    gates.a1?.()
    gates.b1?.()
    gates.b2?.()
    await tick()
    assert.ok(!order.includes('start a3'), 'a3 waits for a2')
    gates.a2?.()
    await tick()
    assert.equal(order.at(-1), 'start a3')
    gates.a3?.()
    await running
    assert.ok(!order.includes('start b3'), 'b agreed after two')
    assert.equal(states.get(5), 'skipped')
  })
})
