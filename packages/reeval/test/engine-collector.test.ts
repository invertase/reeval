// The collector (engine/collector.ts): the tree `evaluate` and `group` declare, in Vitest's order,
// and which tests run after `.only`, `.skip` and `.todo`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type CollectedTest,
  collect,
  collectingFile,
  registerGroup,
  registerTest,
} from '../src/engine/collector.ts'
import type { TestMode } from '../src/engine/runtime.ts'

const body = async () => {}
const t = (name: string, mode: TestMode = 'run') => registerTest(name, { mode }, body)
const g = (name: string, fn: () => unknown, mode: TestMode = 'run') =>
  registerGroup(name, mode, fn as () => void)
const modes = (tests: CollectedTest[]) =>
  tests.map((x) => `${[...x.groups, x.name].join('/')}:${x.mode}`)

describe('collect', () => {
  test('group bodies run after the code around them, in order, and tests keep declaration order', async () => {
    const order: string[] = []
    const tests = await collect('/f.eval.ts', async () => {
      order.push(`top ${collectingFile()}`)
      g('outer', () => {
        order.push('outer')
        g('inner', async () => {
          await Promise.resolve()
          order.push('inner')
          t('deep')
        })
        t('mid')
      })
      t('first')
      order.push('after outer')
    })
    assert.deepEqual(order, ['top /f.eval.ts', 'after outer', 'outer', 'inner'])
    assert.deepEqual(modes(tests), ['outer/inner/deep:run', 'outer/mid:run', 'first:run'])
    assert.deepEqual(
      tests.map((x) => x.index),
      [0, 1, 2],
    )
    assert.equal(collectingFile(), undefined, 'not collecting once done')
  })

  test('declaring outside a file load is refused', () => {
    assert.throws(() => t('late'), /can't be called inside an eval/)
    assert.throws(() => g('late', () => {}), /can't be called inside an eval/)
  })

  test("a group body's error fails the collection, and collecting stops", async () => {
    await assert.rejects(
      collect('/f.eval.ts', async () =>
        g('bad', () => {
          throw new Error('in the group')
        }),
      ),
      /in the group/,
    )
    await assert.rejects(
      collect('/f.eval.ts', async () => {
        throw new Error('at import')
      }),
      /at import/,
    )
    assert.equal(collectingFile(), undefined)
  })
})

describe('modes', () => {
  test('without .only, skip and todo groups mark their tests; run tests run', async () => {
    const tests = await collect('/f', async () => {
      t('a')
      t('b', 'skip')
      t('c', 'todo')
      g(
        'parked',
        () => {
          t('in')
          g('nested', () => t('deeper'))
          t('already todo', 'todo')
        },
        'skip',
      )
      g('later', () => t('x'), 'todo')
    })
    assert.deepEqual(modes(tests), [
      'a:run',
      'b:skip',
      'c:todo',
      'parked/in:skip',
      'parked/nested/deeper:skip',
      'parked/already todo:todo',
      'later/x:todo',
    ])
  })

  test('.only narrows its own file: only tests and only groups run, the rest skip', async () => {
    const tests = await collect('/f', async () => {
      t('a')
      t('b', 'only')
      g(
        'focused',
        () => {
          t('all of it')
          t('skipped anyway', 'skip')
        },
        'only',
      )
      g('other', () => t('no'))
      g('holds one', () => {
        t('no')
        t('yes', 'only')
      })
    })
    assert.deepEqual(modes(tests), [
      'a:skip',
      'b:run',
      'focused/all of it:run',
      'focused/skipped anyway:skip',
      'other/no:skip',
      'holds one/no:skip',
      'holds one/yes:run',
    ])
  })

  test('an only group with an only test inside runs just that test', async () => {
    const tests = await collect('/f', async () => {
      g(
        'focused',
        () => {
          t('not this')
          t('this', 'only')
        },
        'only',
      )
    })
    assert.deepEqual(modes(tests), ['focused/not this:skip', 'focused/this:run'])
  })

  test('a skipped group wins over .only inside it, which runs nothing (as in Vitest)', async () => {
    const tests = await collect('/f', async () => {
      g(
        'parked',
        () => {
          t('focused', 'only')
          g('nested', () => t('deeper'), 'only')
        },
        'skip',
      )
      g('later', () => t('focused', 'only'), 'todo')
      t('plain')
    })
    assert.deepEqual(modes(tests), [
      'parked/focused:skip',
      'parked/nested/deeper:skip',
      'later/focused:todo',
      'plain:skip',
    ])
  })

  test('a skipped group inside a skipped group skips its evals, .only ones too', async () => {
    const tests = await collect('/f', async () => {
      g(
        'outer',
        () =>
          g(
            'inner',
            () => {
              t('plain')
              t('focused', 'only')
            },
            'skip',
          ),
        'skip',
      )
      g('parked', () => g('inner', () => t('plain'), 'skip'), 'todo')
    })
    assert.deepEqual(modes(tests), [
      'outer/inner/plain:skip',
      'outer/inner/focused:skip',
      'parked/inner/plain:skip',
    ])
  })
})
