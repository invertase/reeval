import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import { colors } from '../src/ui/colors.ts'
import { endLine, startLine } from '../src/ui/header.ts'
import { CONFIRM_MS, frameLines, ListApp, wrap } from '../src/ui/ink-list.ts'
import { LiveList } from '../src/ui/list.ts'
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

const FINISHED = {
  done: 'Done in 1.2s · 1 failed · 2 passed',
  notes: [],
  pointer: 'Browse it: reeval studio',
  errors: [],
}

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
    { files: files(), logs: [], counts: { done: 2, total: 3 }, phase: null, finished: null },
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

test('during the run, a first q asks and a second cancels; Ctrl-C cancels at once', async () => {
  const store = new ListStore()
  store.set({ files: files(), counts: { done: 2, total: 3 } })
  let canceled = 0
  const app = mount(store, () => canceled++)
  try {
    await settle()
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 0, 'one q only asks')
    assert.match(app.frame(), /^Press q again to cancel the run\.$/m)
    assert.doesNotMatch(app.frame(), /q cancel$/m, 'the question stands in for the keys')
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 1, 'the second q cancels')
    assert.match(app.frame(), /↑↓ move · → open · q cancel/)
    app.stdin.write('\u0003')
    await settle()
    assert.equal(canceled, 2, 'Ctrl-C cancels without asking')
  } finally {
    app.unmount()
  }
})

test('a first q that no second follows lapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = new ListStore()
  store.set({ files: files(), counts: { done: 2, total: 3 } })
  let canceled = 0
  const app = mount(store, () => canceled++)
  try {
    await settle()
    app.stdin.write('q')
    await settle()
    assert.match(app.frame(), /Press q again/)
    t.mock.timers.tick(CONFIRM_MS)
    await settle()
    assert.doesNotMatch(app.frame(), /Press q again/)
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 0, 'a q after it lapsed asks again')
  } finally {
    app.unmount()
  }
})

test('once the run has ended, q quits at once and takes the whole frame down', async () => {
  const store = new ListStore()
  store.set({ files: files(), logs: ['a notice'], counts: { done: 3, total: 3 } })
  let canceled = 0
  const app = mount(store, () => canceled++)
  try {
    await settle()
    store.set({ finished: FINISHED })
    await settle()
    app.stdin.write('q')
    await settle()
    assert.equal(canceled, 0, 'q quits rather than cancels')
    assert.doesNotMatch(app.frame(), /evals\/|Done in|q quit/, 'nothing of the list is left')
  } finally {
    app.unmount()
  }
})

test('the header line above the list says Running... while it goes, then how the run ended', async () => {
  const store = new ListStore()
  const output = { outputLogs: 'none', logOrder: 'stream' } as never
  store.set({ files: files(), counts: { done: 2, total: 3 }, phase: startLine(c, output) })
  const app = mount(store)
  try {
    await settle()
    assert.match(app.frame(), /^ {2}◆ {2}Running\.\.\.$/m)
    store.set({ phase: endLine(c, 'complete'), finished: FINISHED })
    await settle()
    assert.match(app.frame(), /^ {2}◆ {2}Finished\.$/m)
    assert.doesNotMatch(app.frame(), /Running/)
    store.set({ phase: endLine(c, 'interrupted') })
    await settle()
    assert.match(app.frame(), /^ {2}◆ {2}Canceled\.$/m)
  } finally {
    app.unmount()
  }
})

test('files keep path order while they run and once they end, whichever was collected first', async () => {
  const live = new LiveList('fake')
  const collected = (path: string, name: string) =>
    live.collected(path, [{ id: name, key: `${path}::${name}`, group: [], name, skipped: false }])
  collected('evals/b.eval.ts', 'second')
  collected('evals/a.eval.ts', 'first')
  const store = new ListStore()
  store.set({ files: live.files(), counts: { done: 0, total: 2 } })
  const app = mount(store)
  try {
    await settle()
    const order = () => [...app.frame().matchAll(/^evals\/\w\.eval\.ts$/gm)].map((m) => m[0])
    assert.deepEqual(order(), ['evals/a.eval.ts', 'evals/b.eval.ts'])
    store.set({
      files: [
        { path: 'evals/a.eval.ts', rows: [row('first')] },
        { path: 'evals/b.eval.ts', rows: [row('second')] },
      ],
      finished: FINISHED,
    })
    await settle()
    assert.deepEqual(order(), ['evals/a.eval.ts', 'evals/b.eval.ts'], 'no file moves')
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

test('the frame fits the terminal, wrapped footer included, and refits when it resizes', async () => {
  const many: StatusFile[] = [
    { path: 'evals/many.eval.ts', rows: Array.from({ length: 40 }, (_, i) => row(`eval ${i}`)) },
  ]
  const store = new ListStore()
  store.set({
    files: many,
    counts: { done: 40, total: 40 },
    finished: {
      ...FINISHED,
      notes: ['1 eval stopped at its budget'],
      pointer: `Browse it: reeval studio · summary ${'x'.repeat(150)}`,
    },
  })
  const app = mount(store)
  const stdout = app.stdout as unknown as { rows?: number; emit: (e: string) => void }
  try {
    for (const rows of [24, 12, 30]) {
      stdout.rows = rows
      stdout.emit('resize')
      await settle()
      const tall = app
        .frame()
        .split('\n')
        .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 100)), 0)
      assert.ok(tall < rows, `${tall} lines in a ${rows}-row terminal`)
      assert.match(app.frame(), /q quit$/m, `the keys show at ${rows} rows`)
    }
  } finally {
    app.unmount()
  }
})
