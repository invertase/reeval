import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import { colors } from '../src/ui/colors.ts'
import { frameLines, ListApp, wrap } from '../src/ui/ink-list.ts'
import type { StatusFile, StatusRow } from '../src/ui/status.ts'
import { ListStore } from '../src/ui/tty.ts'

const c = colors(false)
const KEY = { up: '\u001B[A', down: '\u001B[B', right: '\u001B[C', left: '\u001B[D' }

const row = (id: string, over: Partial<StatusRow> = {}): StatusRow => ({
  id,
  name: id,
  icon: 'pass',
  summary: '1 of 1 run passed',
  detail: [],
  remarks: 0,
  compare: false,
  ...over,
})

const files = (): StatusFile[] => [
  {
    path: 'evals/a.eval.ts',
    rows: [
      row('writes greet.js'),
      row('greets in French', {
        icon: 'fail',
        summary: '0 of 1 run passed',
        detail: [
          { depth: 0, text: 'Failed on fake.' },
          { depth: 1, text: 'expected greeting to be bonjour', tone: 'red' },
        ],
      }),
    ],
  },
  { path: 'evals/b.eval.ts', rows: [row('runs the tests', { icon: 'running', summary: '' })] },
]

/** Ink draws on the next tick, so a frame is read after input has had one. */
const settle = () => sleep(30)

const mount = (store: ListStore, cancel = () => {}) => {
  const app = render(h(ListApp, { store, colors: c, cancel }))
  return { ...app, frame: () => app.lastFrame() ?? '' }
}

test('wrap breaks at a space past a third of the width, else mid-word', () => {
  assert.deepEqual(wrap('expected greeting to be bonjour', 16), [
    'expected',
    'greeting to be',
    'bonjour',
  ])
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
})

test('frameLines tags each line with its row and opens only the expanded one', () => {
  const lines = frameLines(
    { files: files(), logs: [], counts: { done: 2, total: 3 }, finished: null },
    c,
    1,
    'greets in French',
    0,
  )
  assert.deepEqual(
    lines.map((l) => [l.row, l.text.trimEnd()]),
    [
      [-1, 'evals/a.eval.ts'],
      [0, '  ✓ writes greet.js   1 of 1 run passed'],
      [1, '❯ ✗ greets in French  0 of 1 run passed'],
      [1, '      Failed on fake.'],
      [1, '        expected greeting to be bonjour'],
      [-1, ''],
      [-1, 'evals/b.eval.ts'],
      [2, '  ⠋ runs the tests'],
    ],
  )
})

test('while the run goes: a spinner, the count, and the arrows move and open a row', async () => {
  const store = new ListStore()
  store.set({ files: files(), counts: { done: 2, total: 3 } })
  const app = mount(store)
  try {
    await settle()
    assert.match(app.frame(), /^❯ ✓ writes greet\.js/m, 'the first row is selected')
    assert.match(app.frame(), /^2 of 3 evals done$/m)
    assert.match(app.frame(), /↑↓ move · → open · q cancel/)
    assert.doesNotMatch(app.frame(), /Failed on fake/, 'nothing is open yet')
    app.stdin.write(KEY.down)
    await settle()
    app.stdin.write(KEY.right)
    await settle()
    assert.match(app.frame(), /^❯ ✗ greets in French/m)
    assert.match(app.frame(), /^ {6}Failed on fake\.$/m)
    app.stdin.write(KEY.left)
    await settle()
    assert.doesNotMatch(app.frame(), /Failed on fake/, '← folds it')
    app.stdin.write(KEY.up)
    app.stdin.write(KEY.up)
    await settle()
    assert.match(app.frame(), /^❯ ✓ writes greet\.js/m, '↑ stops at the first row')
  } finally {
    app.unmount()
  }
})

test('q cancels a run in progress, and quits once it has ended', async () => {
  const store = new ListStore()
  store.set({ files: files(), counts: { done: 2, total: 3 } })
  let canceled = 0
  const app = mount(store, () => canceled++)
  try {
    await settle()
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 1)
    store.set({
      finished: {
        done: 'Done in 1.2s · 1 failed · 2 passed',
        notes: [],
        pointer: 'Browse it: reeval studio',
        errors: [],
      },
    })
    await settle()
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 1, 'once the run has ended, q quits rather than cancels')
  } finally {
    app.unmount()
  }
})

test('once the run ends, the first failure is selected and open, with the tally and the keys', async () => {
  const store = new ListStore()
  store.set({ files: files(), counts: { done: 2, total: 3 } })
  const app = mount(store)
  try {
    await settle()
    const done = files()
    done[1] = { path: 'evals/b.eval.ts', rows: [row('runs the tests')] }
    store.set({
      files: done,
      finished: {
        done: 'Done in 1.2s · 1 failed · 2 passed',
        notes: ['1 eval stopped at its budget'],
        pointer: 'Browse it: reeval studio · summary .reeval/runs/r/summary.md',
        errors: ['evals/c.eval.ts failed to load\nat line 3'],
      },
    })
    await settle()
    const frame = app.frame()
    assert.match(frame, /^❯ ✗ greets in French/m)
    assert.match(frame, /^ {8}expected greeting to be bonjour$/m)
    assert.match(frame, /^error: evals\/c\.eval\.ts failed to load$/m, "an error's first line")
    assert.match(frame, /^1 eval stopped at its budget$/m)
    assert.match(frame, /^Done in 1\.2s · 1 failed · 2 passed$/m)
    assert.match(frame, /↑↓ move · → open · ← close · q quit/)
    assert.doesNotMatch(frame, /evals done/)
  } finally {
    app.unmount()
  }
})

test("a list taller than the terminal scrolls to keep the selected row's lines on screen", async () => {
  const many: StatusFile[] = [
    { path: 'evals/many.eval.ts', rows: Array.from({ length: 40 }, (_, i) => row(`eval ${i}`)) },
  ]
  const store = new ListStore()
  store.set({ files: many, counts: { done: 40, total: 40 } })
  const app = mount(store)
  try {
    await settle()
    assert.match(app.frame(), /eval 0 /)
    assert.doesNotMatch(app.frame(), /eval 39 /, 'only what fits 24 rows')
    for (let i = 0; i < 39; i++) app.stdin.write(KEY.down)
    await settle()
    assert.match(app.frame(), /^❯ ✓ eval 39 /m)
    assert.doesNotMatch(app.frame(), /eval 0 /)
  } finally {
    app.unmount()
  }
})
