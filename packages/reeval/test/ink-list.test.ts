import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import { colors } from '../src/ui/colors.ts'
import { endText, startText } from '../src/ui/header.ts'
import { CONFIRM_MS, doneLine, frameLines, ListApp, openDetail, wrap } from '../src/ui/ink-list.ts'
import { LiveList, SPINNER } from '../src/ui/list.ts'
import type { StatusFile, StatusRow } from '../src/ui/status.ts'
import { ListStore, rowsOf, StepSpinner } from '../src/ui/tty.ts'

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
          { depth: 0, mark: 'fail', text: 'says bonjour  failed 1 of 1 run' },
          { depth: 1, text: 'expected greeting to be bonjour', tone: 'dim' },
          { depth: 1, text: 'the file as the agent left it', tone: 'dim', only: 'full' },
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
      [1, '      ✗ says bonjour  failed 1 of 1 run'],
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
    assert.doesNotMatch(app.frame(), /says bonjour/, 'nothing is open yet')
    app.stdin.write(KEY.down)
    await settle()
    app.stdin.write(KEY.right)
    await settle()
    assert.match(app.frame(), /^❯ ✗ greets in French/m)
    assert.match(app.frame(), /^ {6}✗ says bonjour {2}failed 1 of 1 run$/m)
    assert.doesNotMatch(
      app.frame(),
      /the file as the agent left it/,
      'full detail waits for → again',
    )
    assert.match(app.frame(), /↑↓ move · → more · q cancel/)
    app.stdin.write(KEY.right)
    await settle()
    assert.match(
      app.frame(),
      /^ {8}the file as the agent left it$/m,
      '→ again shows the full detail',
    )
    app.stdin.write(KEY.left)
    await settle()
    assert.doesNotMatch(
      app.frame(),
      /the file as the agent left it/,
      '← steps back to the short detail',
    )
    assert.match(app.frame(), /says bonjour/)
    app.stdin.write(KEY.left)
    await settle()
    assert.doesNotMatch(app.frame(), /says bonjour/, '← folds it')
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

test('the header line above the list spins on Running... while it goes, then says how the run ended', async () => {
  const store = new ListStore()
  const output = { outputLogs: 'none', logOrder: 'stream' } as never
  store.set({ files: files(), counts: { done: 2, total: 3 }, phase: startText(output) })
  const app = mount(store)
  try {
    await settle()
    assert.match(app.frame(), /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] {2}Running\.\.\.$/m)
    store.set({ phase: endText('complete'), finished: FINISHED })
    await settle()
    assert.match(app.frame(), /^ {2}◆ {2}Finished\.$/m)
    assert.doesNotMatch(app.frame(), /Running/)
    store.set({ phase: endText('interrupted') })
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
    assert.match(frame, /↑↓ move · → more · ← close · q quit/, 'the open row has more to show')
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

test('an eval still going with a failed run spins, red, and only gets its ✗ once every run ended', () => {
  const live = new LiveList('fake')
  const evals = ['one', 'two'].map((n) => ({
    id: 'greets',
    key: `evals/a.eval.ts::greets::${n}`,
    group: [],
    name: 'greets',
    skipped: false,
  }))
  live.collected('evals/a.eval.ts', evals)
  const [one, two] = evals.map(
    (e) =>
      ({
        key: e.key,
        attempt: { n: 1, gate: 'all', label: 'fake #1', cell: { key: 'fake/-/fake' } },
      }) as never,
  )
  live.start(one)
  live.start(two)
  live.end({
    key: evals[0]?.key,
    state: 'failed',
    errors: ['AssertionError: expected bonjour'],
  } as never)
  const going = live.files()[0]?.rows[0]
  assert.equal(going?.icon, 'failing')
  assert.equal(going?.summary, '1 of 2 runs done')
  assert.deepEqual(live.counts(), { done: 0, total: 1, running: 1, failed: 0, failing: 1 })
  const state = {
    files: live.files(),
    logs: [],
    counts: live.counts(),
    phase: null,
    finished: null,
  }
  const red = colors(true)
  const head = frameLines(state, red, -1, null, 0)[1]?.text ?? ''
  assert.ok(head.includes(red.red('⠋')), 'the spinner is red')
  assert.doesNotMatch(head, /✗/, 'no ✗ while a run goes')
  live.end({ key: evals[1]?.key, state: 'passed', errors: [] } as never)
  assert.equal(live.files()[0]?.rows[0]?.icon, 'fail')
  assert.deepEqual(live.counts(), { done: 1, total: 1, running: 0, failed: 1, failing: 0 })
})

test('under a passRate gate, a failed run marks the eval only once its cell can no longer pass', () => {
  const live = new LiveList('fake')
  const evals = ['1', '2', '3', '4'].map((n) => ({
    id: 'flaky',
    key: `evals/a.eval.ts::flaky::${n}`,
    group: [],
    name: 'flaky',
    skipped: false,
  }))
  live.collected('evals/a.eval.ts', evals)
  const ref = (key: string) =>
    ({
      key,
      attempt: { n: 1, gate: { passRate: 0.5 }, label: 'fake', cell: { key: 'fake/-/fake' } },
    }) as never
  const end = (key: string, state: 'passed' | 'failed') =>
    live.end({ ...(ref(key) as object), state, errors: state === 'failed' ? ['no'] : [] } as never)
  const [a, b, c, d] = evals.map((e) => e.key) as [string, string, string, string]
  live.start(ref(a))
  end(a, 'failed')
  assert.equal(live.files()[0]?.rows[0]?.icon, 'running', '1 fail of 4 can still pass at 0.5')
  for (const k of [b, c, d]) {
    live.start(ref(k))
    end(k, 'passed')
  }
  assert.equal(live.files()[0]?.rows[0]?.icon, 'pass', '3 of 4 meets passRate 0.5')
  const strict = new LiveList('fake')
  strict.collected('evals/a.eval.ts', evals)
  for (const k of [a, b, c]) {
    strict.start(ref(k))
    strict.end({ ...(ref(k) as object), state: 'failed', errors: ['no'] } as never)
  }
  assert.equal(strict.files()[0]?.rows[0]?.icon, 'failing', '3 fails of 4 can no longer reach 0.5')
})

/** An eval with cases as `collected` lists it: each attempt planned in its cell. */
const caseEvals = (cases: string[], harnesses: string[]) =>
  cases.flatMap((k, i) =>
    harnesses.map((harness) => ({
      id: `evals/a.eval.ts › bank [${k}]`,
      key: `evals/a.eval.ts › bank [${k}] # ${harness}/-/fake#1`,
      group: [],
      name: `bank [${k}]`,
      skipped: false,
      attempt: {
        n: 1,
        gate: 'all',
        label: harness,
        cell: {
          key: `${harness}/-/fake`,
          harness,
          environment: '-',
          sandbox: 'fake',
          role: 'control',
        },
        family: { id: 'evals/a.eval.ts › bank', name: 'bank', case: i, cases: cases.length },
      } as never,
    })),
  )

const caseRef = (k: string, harness: string) => {
  const key = `evals/a.eval.ts › bank [${k}] # ${harness}/-/fake#1`
  return {
    key,
    attempt: { n: 1, gate: 'all', label: harness, cell: { key: `${harness}/-/fake` } },
  } as never
}

test('an eval with cases is one row while it runs, its case table filling in as attempts end', () => {
  const live = new LiveList('fake')
  live.collected('evals/a.eval.ts', caseEvals(['red', 'blue', 'green'], ['claude', 'codex']))
  const rows = () => live.files()[0]?.rows ?? []
  assert.equal(rows().length, 1, 'one row for the eval, not one per case')
  assert.equal(rows()[0]?.name, 'bank')
  assert.deepEqual(
    rows()[0]?.detail.map((d) => [d.mark, d.text]),
    [
      [undefined, '  case   claude  codex'],
      ['queued', 'red    queued  queued'],
      ['queued', 'blue   queued  queued'],
      ['queued', 'green  queued  queued'],
    ],
    'queued, every cell is known from the plan',
  )
  live.start(caseRef('red', 'claude'))
  live.start(caseRef('red', 'codex'))
  live.start(caseRef('blue', 'claude'))
  live.end({ ...(caseRef('red', 'claude') as object), state: 'passed' } as never)
  live.end({ ...(caseRef('blue', 'claude') as object), state: 'failed', errors: ['no'] } as never)
  assert.equal(rows()[0]?.summary, '2 of 6 runs done · 3 cases')
  assert.equal(rows()[0]?.icon, 'failing', 'a failed case spins it red')
  assert.deepEqual(
    rows()[0]?.detail.map((d) => [d.mark, d.text]),
    [
      [undefined, '  case   claude  codex'],
      ['spin', 'red    1 of 1  running'],
      ['queued', 'blue   0 of 1  queued'],
      ['queued', 'green  queued  queued'],
    ],
  )
  assert.equal(
    rows()[0]?.detail[2]?.note,
    'no',
    "a failed attempt's message is its case row's note",
  )
  for (const [k, h] of [
    ['red', 'codex'],
    ['blue', 'codex'],
    ['green', 'claude'],
    ['green', 'codex'],
  ] as const) {
    live.start(caseRef(k, h))
    live.end({ ...(caseRef(k, h) as object), state: 'passed' } as never)
  }
  assert.deepEqual(
    rows()[0]?.detail.map((d) => [d.mark, d.text]),
    [
      [undefined, '  case   claude  codex'],
      ['pass', 'red    1 of 1  1 of 1'],
      ['fail', 'blue   0 of 1  1 of 1'],
      ['pass', 'green  1 of 1  1 of 1'],
    ],
  )
  assert.deepEqual(live.counts(), { done: 1, total: 1, running: 0, failed: 1, failing: 0 })
})

test("a compare's live case table heads its columns as the finished table does, the control first", () => {
  const live = new LiveList('fake')
  const arm = (env: string, role: string, variant?: string) => ({
    key: `fake/${env}/fake`,
    harness: 'fake',
    environment: env,
    sandbox: 'fake',
    role,
    ...(variant ? { variant } : {}),
  })
  live.collected(
    'evals/a.eval.ts',
    ['a', 'b'].flatMap((k, i) =>
      [arm('skilled', 'variant', 'skilled'), arm('app', 'control')].map((cell) => ({
        id: `evals/a.eval.ts › w [${k}]`,
        key: `evals/a.eval.ts › w [${k}] # ${cell.key}#1`,
        group: [],
        name: `w [${k}]`,
        skipped: false,
        attempt: {
          n: 1,
          gate: 'all',
          label: cell.role === 'control' ? 'control' : 'skilled',
          cell,
          family: { id: 'evals/a.eval.ts › w', name: 'w', case: i, cases: 2 },
        } as never,
      })),
    ),
  )
  assert.equal(live.files()[0]?.rows[0]?.detail[0]?.text, '  case  app (control)  skilled')
})

test('a queued attempt names its harness and its run in the cell, from the plan', () => {
  const live = new LiveList('fake')
  live.collected(
    'evals/a.eval.ts',
    caseEvals(['red'], ['claude']).map((x) => ({
      ...x,
      attempt: { ...(x.attempt as object), n: 2 } as never,
    })),
  )
  live.collected('evals/b.eval.ts', [
    {
      id: 'evals/b.eval.ts › greets',
      key: 'evals/b.eval.ts › greets # codex/-/fake#3',
      group: [],
      name: 'greets',
      skipped: false,
      attempt: { n: 3, gate: 'all', label: 'codex #3', cell: { key: 'codex/-/fake' } } as never,
    },
  ])
  assert.deepEqual(
    live.files()[1]?.rows[0]?.detail.map((d) => d.text),
    ['codex #3 queued'],
  )
})

const caseRows = (n: number, marked = true): StatusRow =>
  row('bank', {
    icon: 'fail',
    detail: [
      { depth: 0, text: 'Failed on q001; 11 of 12 cases passed.' },
      { depth: 0, text: `${marked ? '  ' : ''}case  claude`, tone: 'dim', cases: 'head' },
      ...Array.from({ length: n }, (_, i) => ({
        depth: 0 as const,
        text: `q${String(i + 1).padStart(3, '0')}  ${i ? '1' : '0'} of 1`,
        cases: 'row' as const,
        ...(marked ? { mark: i ? ('pass' as const) : ('fail' as const) } : {}),
        ...(i < 8 ? {} : { only: 'full' as const }),
      })),
      ...(n > 8
        ? [
            {
              depth: 0 as const,
              text: `+${n - 8} more cases passed (-v)`,
              tone: 'dim' as const,
              only: 'compact' as const,
              cases: 'more' as const,
            },
          ]
        : []),
      { depth: 0, mark: 'fail', text: 'answers  failed on q001' },
      { depth: 1, text: 'the file as the agent left it', tone: 'dim', only: 'full' },
    ],
  })

test('an open eval with cases shows its first 5, → shows every case, ← steps back to 5 then folds', async () => {
  const store = new ListStore()
  store.set({
    files: [{ path: 'evals/a.eval.ts', rows: [caseRows(12)] }],
    counts: { done: 0, total: 1 },
  })
  const app = mount(store)
  try {
    await settle()
    assert.doesNotMatch(app.frame(), /q001/, 'collapsed')
    app.stdin.write(KEY.right)
    await settle()
    const open = app.frame()
    assert.match(open, /^ {6}✗ q001 {2}0 of 1$/m)
    assert.match(open, /^ {6}✓ q005 {2}1 of 1$/m)
    assert.doesNotMatch(open, /q006/, 'the first 5 cases')
    assert.match(open, /^ {8}7 cases hidden, → to show$/m, 'under the case column')
    assert.doesNotMatch(open, /more cases passed \(-v\)/, "the printed list's count isn't here")
    assert.match(open, /answers {2}failed on q001/, 'the failed check still shows')
    assert.match(open, /→ more/)
    app.stdin.write(KEY.right)
    await settle()
    const full = app.frame()
    assert.match(full, /^ {6}✓ q012 {2}1 of 1$/m, '→ again shows every case')
    assert.doesNotMatch(full, /hidden/)
    assert.match(full, /the file as the agent left it/)
    app.stdin.write(KEY.left)
    await settle()
    assert.match(app.frame(), /7 cases hidden/, '← steps back to 5')
    assert.doesNotMatch(app.frame(), /q012/)
    app.stdin.write(KEY.left)
    await settle()
    assert.doesNotMatch(app.frame(), /q001/, '← again folds it')
  } finally {
    app.unmount()
  }
})

test('openDetail hides nothing for 5 cases or fewer, and an unmarked table lines its count up', () => {
  const five = openDetail(caseRows(5).detail, false)
  assert.equal(five.filter((l) => l.cases === 'row').length, 5)
  assert.ok(!five.some((l) => /hidden/.test(l.text)))
  const six = openDetail(caseRows(6, false).detail, false)
  assert.equal(six.filter((l) => l.cases === 'row').length, 5)
  assert.ok(six.some((l) => l.text === '1 case hidden, → to show'))
  const many = caseRows(12)
  assert.equal(
    openDetail(many.detail, true).filter((l) => l.cases === 'row').length,
    12,
    'full: every case, as -v prints them',
  )
})

test('openDetail keeps the failed and the running cases a long table would hide past its first 5', () => {
  const live = new LiveList('fake')
  const names = Array.from({ length: 12 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`)
  live.collected('evals/a.eval.ts', caseEvals(names, ['claude']))
  for (const k of names.slice(0, 9)) {
    live.start(caseRef(k, 'claude'))
    if (k !== 'q08' && k !== 'q09')
      live.end({ ...(caseRef(k, 'claude') as object), state: 'passed' } as never)
  }
  live.start(caseRef('q10', 'claude'))
  live.end({ ...(caseRef('q10', 'claude') as object), state: 'failed', errors: ['no'] } as never)
  const open = openDetail(live.files()[0]?.rows[0]?.detail ?? [], false)
  assert.deepEqual(
    open.filter((l) => l.cases === 'row').map((l) => [l.mark, l.text.split(' ')[0]]),
    [
      ['pass', 'q01'],
      ['pass', 'q02'],
      ['spin', 'q08'],
      ['spin', 'q09'],
      ['fail', 'q10'],
    ],
    'the failed case and both running ones, then the first passes, in table order',
  )
  assert.ok(open.some((l) => l.text === '  7 cases hidden, → to show'))
  assert.ok(
    open.findIndex((l) => /hidden/.test(l.text)) > open.findIndex((l) => l.text.startsWith('q10')),
    'the count follows the table',
  )
})

test('the footer counts the evals done, then those failed and those failing', () => {
  assert.equal(doneLine(c, { done: 9, total: 10 }), '9 of 10 evals done')
  assert.equal(
    doneLine(c, { done: 9, total: 10, failed: 1, failing: 1 }),
    '9 of 10 evals done · 1 failed · 1 failing',
  )
})

test("before the list, the prepare step's glyph spins in place, then settles to ◆ once each sandbox reports", (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const out: string[] = []
  const spinner = new StepSpinner(
    (s) => out.push(s),
    c,
    () => ({ rows: 24, columns: 80 }),
  )
  spinner.start('  ◆  Preparing 2 sandboxes...\n', 2)
  assert.deepEqual(out, [`\x1b[1A\r\x1b[2C${SPINNER[0]}\r\x1b[1B`], 'up to the step line and back')
  spinner.before('  ✓  cursor ready\n')
  t.mock.timers.tick(80)
  assert.equal(
    out.at(-1),
    `\x1b[2A\r\x1b[2C${SPINNER[1]}\r\x1b[2B`,
    'a line under it moves it up one more',
  )
  spinner.reported()
  t.mock.timers.tick(80)
  assert.equal(out.at(-1), `\x1b[2A\r\x1b[2C${SPINNER[2]}\r\x1b[2B`, 'one sandbox still preparing')
  spinner.reported()
  assert.equal(out.at(-1), '\x1b[2A\r\x1b[2C◆\r\x1b[2B', 'the last one settles it')
  const drawn = out.length
  t.mock.timers.tick(800)
  assert.equal(out.length, drawn, 'and it stops')
})

test('the prepare step settles rather than spin a line about to scroll out of reach', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const out: string[] = []
  const spinner = new StepSpinner(
    (s) => out.push(s),
    c,
    () => ({ rows: 4, columns: 80 }),
  )
  spinner.start('  ◆  Preparing...\n', 1)
  spinner.before('a\nb\n')
  assert.equal(out.at(-1), '\x1b[1A\r\x1b[2C◆\r\x1b[1B')
  t.mock.timers.tick(800)
  assert.equal(out.length, 2)
})

test('the prepare step counts wide characters by their columns', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const out: string[] = []
  const spinner = new StepSpinner(
    (s) => out.push(s),
    c,
    () => ({ rows: 24, columns: 10 }),
  )
  spinner.start('  ◆  Prep\n', 1)
  spinner.before('準備中の箱です\n')
  t.mock.timers.tick(80)
  assert.equal(
    out.at(-1),
    `\x1b[3A\r\x1b[2C${SPINNER[1]}\r\x1b[3B`,
    '14 columns take two lines at 10',
  )
})

test('the prepare step stops without drawing once the width changes or the step is out of reach', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const out: string[] = []
  let size = { rows: 24, columns: 80 }
  const spinner = new StepSpinner(
    (s) => out.push(s),
    c,
    () => size,
  )
  spinner.start('  ◆  Preparing...\n', 1)
  spinner.before(`${'x'.repeat(60)}\n`)
  t.mock.timers.tick(80)
  assert.equal(out.at(-1), `\x1b[2A\r\x1b[2C${SPINNER[1]}\r\x1b[2B`)
  size = { rows: 24, columns: 30 }
  const drawn = out.length
  t.mock.timers.tick(800)
  spinner.reported()
  assert.equal(out.length, drawn, 'a terminal may or may not have reflowed, so the row is unknown')
  spinner.start('  ◆  Preparing...\n', 1)
  size = { rows: 1, columns: 30 }
  const again = out.length
  t.mock.timers.tick(800)
  spinner.reported()
  assert.equal(out.length, again, 'a step line past the top is never drawn on')
})

test('a line takes the rows a terminal places it on', () => {
  assert.equal(
    rowsOf('\t\t\tabcdef', 20),
    2,
    'a tab stops at the last column, the text wraps after it',
  )
  assert.equal(rowsOf(`${'x'.repeat(15)}\r${'y'.repeat(15)}`, 20), 1, '\\r writes over the row')
  assert.equal(rowsOf('準'.repeat(21), 21), 3, 'ten to a row, the 21st column left empty')
  assert.equal(rowsOf('準'.repeat(20), 40), 1)
  assert.equal(rowsOf(`\x1b[31m${'x'.repeat(20)}\x1b[39m`, 20), 1, 'a full row waits to wrap')
  assert.equal(rowsOf('\x1b]8;;https://example.com/a/b\x07link\x1b]8;;\x07', 4), 1, 'a hyperlink')
  assert.equal(rowsOf('', 20), 1)
})
