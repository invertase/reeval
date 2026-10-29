import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import type { RunRecord } from '../src/history/types.ts'
import type { AttemptMeta } from '../src/types.ts'
import { AgentRenderer } from '../src/ui/agent.ts'
import { colors, stripAnsi } from '../src/ui/colors.ts'
import type { EvalResult, Progress, ReevalEvent, RunHeader } from '../src/ui/events.ts'
import { progressLine } from '../src/ui/format.ts'
import { type OutputOptions, resolveOutput } from '../src/ui/mode.ts'
import { PlainRenderer } from '../src/ui/plain.ts'
import { Tagger } from '../src/ui/tags.ts'
import { readableRecord } from '../src/view/record.ts'
import { pkgRoot } from './helpers.ts'
import { corpusEntries } from './support/corpus.ts'

const T0 = 1_790_000_000_000
const s = (seconds: number) => T0 + seconds * 1000

const GREET = 'evals/hello.eval.ts › greet module › creates a tested greet module'
const DEFAULT = 'evals/hello.eval.ts › greet module › adds a default name in a follow-up turn'

const CELL = 'cursor:composer-2.5/-/docker'
const keyOf = (id: string) => `${id} # ${CELL}#1`
const attempt = (name: string, group: string[]): AttemptMeta => ({
  name,
  groups: group,
  tags: [],
  cell: {
    key: CELL,
    harness: 'cursor:composer-2.5',
    environment: '-',
    sandbox: 'docker',
    role: 'control',
  },
  n: 1,
  label: '',
  harness: { kind: 'cursor', model: 'composer-2.5' },
  sandbox: { kind: 'docker' },
  gate: 'all',
  plan: { harnesses: 1, variants: null, runs: 1, attempts: 1, notes: [], warnings: [] },
})

const progress = (id: string, at: number, p: Omit<Progress, 'at'>): ReevalEvent =>
  ({ type: 'eval-progress', key: keyOf(id), progress: { at, ...p } }) as ReevalEvent

const greetResult: EvalResult = {
  id: GREET,
  key: keyOf(GREET),
  file: 'evals/hello.eval.ts',
  group: ['greet module'],
  name: 'creates a tested greet module',
  attempt: attempt('creates a tested greet module', ['greet module']),
  state: 'passed',
  durationMs: 192_000,
  errors: [],
  formattedErrors: [],
  meta: {
    outcome: 'pass',
    errorKind: null,
    judgements: [{ verdict: 'pass', score: 0.92, threshold: 0.8, question: 'Accurate summary?' }],
    recordPath: '',
  },
}

const assertion = [
  'AssertionError: expected 1 to be 2 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 2',
  '+ 1',
  '',
  ' ❯ evals/hello.eval.ts:31:20',
].join('\n')

const defaultResult: EvalResult = {
  id: DEFAULT,
  key: keyOf(DEFAULT),
  file: 'evals/hello.eval.ts',
  group: ['greet module'],
  name: 'adds a default name in a follow-up turn',
  attempt: attempt('adds a default name in a follow-up turn', ['greet module']),
  state: 'failed',
  durationMs: 363_000,
  errors: ['expected 1 to be 2 // Object.is equality'],
  formattedErrors: [`\x1b[31m${assertion}\x1b[39m`],
  meta: { outcome: 'fail', errorKind: 'assertion', judgements: [], recordPath: '' },
}

/** The run's record: the with-layouts corpus run's results.eval.ts, every no-model result shape. */
const layouts = corpusEntries()
  .find((e) => e.name === 'with-layouts')
  ?.runs.at(-1)
assert.ok(layouts, 'the with-layouts corpus entry')
const recorded = readableRecord(layouts.raw as unknown as RunRecord)
const record: RunRecord = {
  ...recorded,
  durationMs: 365_000,
  evals: recorded.evals.filter((e) => e.file === 'evals/results.eval.ts'),
  families: [],
}

/** Two attempts running at once, interleaved as they'd arrive with two workers. */
const interleaved: ReevalEvent[] = [
  {
    type: 'run-start',
    at: T0,
    version: '0.1.0',
    files: 1,
    harness: 'cursor/composer-2.5',
    sandbox: 'docker',
    concurrency: 2,
    runId: '20260101T000000Z_nogit_test_abcd',
  },
  {
    type: 'collected',
    at: T0,
    file: 'evals/hello.eval.ts',
    evals: [
      {
        id: GREET,
        key: keyOf(GREET),
        group: ['greet module'],
        name: greetResult.name,
        skipped: false,
      },
      {
        id: DEFAULT,
        key: keyOf(DEFAULT),
        group: ['greet module'],
        name: defaultResult.name,
        skipped: false,
      },
    ],
  },
  { type: 'eval-start', at: s(0), id: GREET, key: keyOf(GREET), attempt: greetResult.attempt },
  {
    type: 'eval-start',
    at: s(1),
    id: DEFAULT,
    key: keyOf(DEFAULT),
    attempt: defaultResult.attempt,
  },
  progress(GREET, s(1), { kind: 'sandbox' }),
  progress(DEFAULT, s(2), { kind: 'sandbox' }),
  progress(GREET, s(5), { kind: 'sandbox-ready', ms: 4100 }),
  progress(GREET, s(5), { kind: 'turn-start', turn: 1 }),
  progress(DEFAULT, s(6), { kind: 'sandbox-ready', ms: 4200 }),
  progress(DEFAULT, s(6), { kind: 'turn-start', turn: 1 }),
  { type: 'log', at: s(70), key: keyOf(DEFAULT), stream: 'stdout', text: 'seeding greet.js\n' },
  progress(GREET, s(170), {
    kind: 'turn-end',
    turn: 1,
    status: 'completed',
    ms: 165_000,
    tools: 6,
    fileEdits: 2,
  }),
  progress(GREET, s(170), { kind: 'check-start', command: 'node --test' }),
  progress(GREET, s(172), { kind: 'check-end', command: 'node --test', exitCode: 0, ms: 1200 }),
  progress(GREET, s(172), { kind: 'judge-start', question: 'Accurate summary?' }),
  progress(GREET, s(175), {
    kind: 'judge-end',
    question: 'Accurate summary?',
    verdict: 'pass',
    score: 0.92,
    threshold: 0.8,
    ms: 3100,
  }),
  progress(GREET, s(176), { kind: 'cleanup' }),
  { type: 'eval-end', at: s(192), result: greetResult },
  progress(DEFAULT, s(200), {
    kind: 'turn-end',
    turn: 1,
    status: 'completed',
    ms: 194_000,
    tools: 3,
    fileEdits: 1,
  }),
  progress(DEFAULT, s(200), { kind: 'turn-start', turn: 2 }),
  progress(DEFAULT, s(330), {
    kind: 'turn-end',
    turn: 2,
    status: 'completed',
    ms: 130_000,
    tools: 2,
    fileEdits: 1,
  }),
  progress(DEFAULT, s(330), { kind: 'check-start', command: 'node -e "…"\nprocess.exit(1)' }),
  progress(DEFAULT, s(331), {
    kind: 'check-end',
    command: 'node -e "…"\nprocess.exit(1)',
    exitCode: 1,
    ms: 900,
  }),
  { type: 'eval-end', at: s(364), result: defaultResult },
  {
    type: 'run-end',
    at: s(365),
    record,
    summaryPath: '.reeval/runs/run-1/summary.md',
    results: [greetResult, defaultResult],
  },
]

const options = (overrides: Partial<OutputOptions> = {}): OutputOptions => ({
  mode: 'plain',
  statusLine: false,
  logOrder: 'grouped',
  logPrefix: 'task',
  outputLogs: 'full',
  color: false,
  rich: false,
  githubActions: false,
  heartbeatMs: 60_000,
  ...overrides,
})

/** Feeds events to a renderer on a fake non-TTY stream, ticking the heartbeat between them. */
function render(events: ReevalEvent[], output: OutputOptions, color = false): string {
  let text = ''
  let now = T0
  const out = { isTTY: false, write: (chunk: string) => (text += chunk) }
  const renderer = new PlainRenderer({
    out,
    colors: colors(color),
    output,
    harness: 'cursor',
    now: () => now,
    timers: false,
  })
  for (const e of events) {
    const at = 'at' in e ? e.at : e.progress.at
    // Tick once a second up to this event, as the renderer's interval would.
    for (; now < at; now = Math.min(at, now + 1000)) renderer.tick(now)
    now = at
    renderer.onEvent(e)
  }
  renderer.close()
  return text
}

const lines = (...l: string[]) => `${l.join('\n')}\n`

const RESULT = [
  '',
  'pass             writes greet.js',
  '',
  'fail             greets in French',
  '  french greeting  failed',
  '    expected command to succeed, exit code 1',
  '  +1 more passed',
  '',
  'fail             explains why greet.js fails',
  '  2 tries               1 of 2',
  '  names the root cause  1 of 2',
  "    expected 'Docker is down' to contain 'null'",
  '  +1 more passed',
  '',
  'fail             reads the fixture repo',
  '  error            the fixture repo is missing',
  '',
  'infra error      starts its sandbox',
  '  infra error      the fake sandbox fell over',
  '',
  'skipped          greets in Welsh',
  'todo             greets in Klingon',
  '',
  '6m 05s · results .reeval/runs/run-1/summary.md',
  '3 fail · 1 pass · 1 infra error · 2 skipped',
]

describe('plain renderer', () => {
  test('grouped: start lines stream, each attempt prints as one block when it ends', () => {
    assert.equal(
      render(interleaved, options()),
      lines(
        'reeval 0.1.0 · run 20260101T000000Z_nogit_test_abcd · 1 eval file · harness cursor/composer-2.5 · sandbox docker · concurrency 2 · grouped logs',
        '… 2 running after 1m 00s: [creates#1 cursor] turn 1 1m 00s, [adds#1 cursor] turn 1 59s',
        '… 2 running after 2m 00s: [creates#1 cursor] turn 1 2m 00s, [adds#1 cursor] turn 1 1m 59s',
        '… 2 running after 3m 00s: [creates#1 cursor] cleanup 3m 00s, [adds#1 cursor] turn 1 2m 59s',
        '[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
        '[creates#1 cursor]  +0:01 sandbox ready 4s',
        '[creates#1 cursor]  +0:05 turn 1 done 2m 45s · 6 tool calls, 2 file edits',
        '[creates#1 cursor]  +2:50 $ node --test  exit 0 1s',
        '[creates#1 cursor]  +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '… 1 running after 4m 12s: [adds#1 cursor] turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] turn 2 5m 11s',
        '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
        '[adds#1 cursor]  +0:01 sandbox ready 4s',
        '[adds#1 cursor]  +0:05 turn 1 done 3m 14s · 3 tool calls, 1 file edit',
        '[adds#1 cursor]  +1:09 stdout | seeding greet.js',
        '[adds#1 cursor]  +3:19 turn 2 done 2m 10s · 2 tool calls, 1 file edit',
        '[adds#1 cursor]  +5:29 $ node -e "…"…  exit 1 900ms',
        '[adds#1 cursor]  AssertionError: expected 1 to be 2 // Object.is equality',
        '[adds#1 cursor]',
        '[adds#1 cursor]  - Expected',
        '[adds#1 cursor]  + Received',
        '[adds#1 cursor]',
        '[adds#1 cursor]  - 2',
        '[adds#1 cursor]  + 1',
        '[adds#1 cursor]',
        '[adds#1 cursor]   ❯ evals/hello.eval.ts:31:20',
        ...RESULT,
      ),
    )
  })

  test('stream: every prefixed line prints as it happens, interleaved', () => {
    const out = render(interleaved, options({ logOrder: 'stream' })).split('\n')
    assert.deepEqual(out.slice(1, 16), [
      '[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
      '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
      '[creates#1 cursor]  +0:01 sandbox starting',
      '[adds#1 cursor]  +0:01 sandbox starting',
      '[creates#1 cursor]  +0:05 sandbox ready 4s',
      '[creates#1 cursor]  +0:05 turn 1 started',
      '[adds#1 cursor]  +0:05 sandbox ready 4s',
      '[adds#1 cursor]  +0:05 turn 1 started',
      '… 2 running after 1m 06s: [creates#1 cursor] turn 1 1m 06s, [adds#1 cursor] turn 1 1m 05s',
      '[adds#1 cursor]  +1:09 stdout | seeding greet.js',
      '… 2 running after 2m 10s: [creates#1 cursor] turn 1 2m 10s, [adds#1 cursor] turn 1 2m 09s',
      '[creates#1 cursor]  +2:50 turn 1 done 2m 45s · 6 tool calls, 2 file edits',
      '[creates#1 cursor]  +2:50 $ node --test',
      '[creates#1 cursor]  +2:52 $ node --test  exit 0 1s',
      '[creates#1 cursor]  +2:52 judging: Accurate summary?',
    ])
  })

  test('GitHub Actions: passing attempts collapse into groups, failures stay open and annotate', () => {
    const out = render(interleaved, options({ githubActions: true, logPrefix: 'none' }))
    const block = out.slice(out.indexOf('::group::'), out.indexOf('\n', out.indexOf('::error')) + 1)
    assert.equal(
      block,
      lines(
        '::group::[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
        ' +0:01 sandbox ready 4s',
        ' +0:05 turn 1 done 2m 45s · 6 tool calls, 2 file edits',
        ' +2:50 $ node --test  exit 0 1s',
        ' +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '::endgroup::',
        '… 1 running after 4m 12s: [adds#1 cursor] turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] turn 2 5m 11s',
        '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
        ' +0:01 sandbox ready 4s',
        ' +0:05 turn 1 done 3m 14s · 3 tool calls, 1 file edit',
        ' +1:09 stdout | seeding greet.js',
        ' +3:19 turn 2 done 2m 10s · 2 tool calls, 1 file edit',
        ' +5:29 $ node -e "…"…  exit 1 900ms',
        ' AssertionError: expected 1 to be 2 // Object.is equality',
        '',
        ' - Expected',
        ' + Received',
        '',
        ' - 2',
        ' + 1',
        '',
        '  ❯ evals/hello.eval.ts:31:20',
        '::error file=evals/hello.eval.ts,line=31,col=20,title=evals/hello.eval.ts › greet module › adds a default name in a follow-up turn::AssertionError: expected 1 to be 2 // Object.is equality%0A%0A- Expected%0A+ Received%0A%0A- 2%0A+ 1%0A%0A ❯ evals/hello.eval.ts:31:20',
      ),
    )
  })

  test('every failed check prints with its line, and GitHub Actions annotates each one', () => {
    const checked: EvalResult = {
      ...defaultResult,
      meta: {
        outcome: 'fail',
        errorKind: 'assertion',
        judgements: [],
        recordPath: '',
        failedChecks: [
          {
            label: 'toBe 2',
            at: 'evals/hello.eval.ts:31',
            message: 'expected 1 to be 2 // Object.is equality',
          },
          {
            label: 'tests pass',
            at: 'evals/hello.eval.ts:33',
            message: 'tests pass: expected command to succeed, exit code 1',
          },
          { label: 'names it', message: 'names it: expected 1 to be 3' },
        ],
      },
    }
    const events = interleaved.map((e) =>
      e.type === 'eval-end' && e.result === defaultResult ? { ...e, result: checked } : e,
    )
    const out = render(events, options({ githubActions: true, logPrefix: 'none' })).split('\n')
    const at = out.indexOf('  ❯ evals/hello.eval.ts:31:20')
    assert.deepEqual(out.slice(at + 1, at + 6), [
      ' ✗ tests pass  evals/hello.eval.ts:33  expected command to succeed, exit code 1',
      ' ✗ names it  expected 1 to be 3',
      '::error file=evals/hello.eval.ts,line=31,title=evals/hello.eval.ts › greet module › adds a default name in a follow-up turn%3A toBe 2::expected 1 to be 2 // Object.is equality',
      '::error file=evals/hello.eval.ts,line=33,title=evals/hello.eval.ts › greet module › adds a default name in a follow-up turn%3A tests pass::tests pass: expected command to succeed, exit code 1',
      out[at + 5],
    ])
    assert.doesNotMatch(out[at + 5] ?? '', /^::error/, 'one annotation per check, not the attempt')
  })

  test("the attempt's own error is annotated too when it isn't one of its failed checks", () => {
    const long = `expected ${'x'.repeat(600)} to be 2`
    const thrown: EvalResult = {
      ...defaultResult,
      errors: ['Error: user code bug'],
      formattedErrors: ['Error: user code bug\n ❯ evals/hello.eval.ts:40:9'],
      meta: {
        outcome: 'fail',
        errorKind: 'assertion',
        judgements: [],
        recordPath: '',
        failedChecks: [
          { label: 'soft one', at: 'evals/hello.eval.ts:31', message: 'soft one: no' },
        ],
      },
    }
    const clipped: EvalResult = {
      ...defaultResult,
      errors: [long],
      formattedErrors: [long],
      meta: {
        outcome: 'fail',
        errorKind: 'assertion',
        judgements: [],
        recordPath: '',
        failedChecks: [{ label: 'long', message: `${long.slice(0, 499)}…` }],
      },
    }
    for (const [result, annotations, listed] of [
      [thrown, 2, 1],
      [clipped, 1, 0],
    ] as const) {
      const events = interleaved.map((e) =>
        e.type === 'eval-end' && e.result === defaultResult ? { ...e, result } : e,
      )
      const out = render(events, options({ githubActions: true, logPrefix: 'none' }))
      assert.equal(out.match(/^::error /gm)?.length, annotations, out)
      assert.equal(out.match(/^ ✗ /gm)?.length ?? 0, listed, 'the error is not listed again')
    }
  })

  test('errors-only prints detail for failing attempts only', () => {
    const out = render(interleaved, options({ outputLogs: 'errors-only', logOrder: 'stream' }))
    assert.doesNotMatch(out, /\[creates#1 cursor\] {2}\+/)
    assert.match(out, /\[adds#1 cursor\] {2}\+1:09 stdout \| seeding greet\.js/)
  })

  test('color: prefixes get Turborepo palette colors, group titles stay plain', () => {
    const out = render(interleaved, options({ githubActions: true }), true)
    assert.ok(out.includes('\x1b[36m[creates#1 cursor]\x1b[39m'))
    assert.ok(out.includes('\x1b[35m[adds#1 cursor]\x1b[39m'))
    assert.match(out, /^::group::\[creates#1 cursor\] ▶ /m)
  })

  test('the heartbeat stays quiet while other lines are printing, and when it is off', () => {
    const out = render(interleaved, options({ heartbeatMs: 0 }))
    assert.doesNotMatch(out, /running after/)
  })

  test('no line says how an attempt ended; with --output-logs none, nothing prints per attempt', () => {
    for (const logOrder of ['stream', 'grouped'] as const) {
      const out = render(interleaved, options({ logOrder, outputLogs: 'none', heartbeatMs: 0 }))
      assert.equal(
        out,
        lines(
          `reeval 0.1.0 · run 20260101T000000Z_nogit_test_abcd · 1 eval file · harness cursor/composer-2.5 · sandbox docker · concurrency 2 · ${logOrder} logs`,
          ...RESULT,
        ),
      )
    }
    assert.doesNotMatch(render(interleaved, options({ logOrder: 'stream' })), / [✓✗] evals\//)
  })

  test('on a terminal: one status line under the logs, rewritten in place, cleared before the result', () => {
    const out = render(interleaved, options({ statusLine: true, outputLogs: 'none' }))
    const clear = '\r\x1b[2K'
    assert.ok(out.includes(`${clear}2 evals · 0/2 tries`), out)
    assert.ok(out.includes(`${clear}2 evals · 1/2 tries`), out)
    assert.ok(out.includes(`${clear}2 evals · 2/2 tries${clear}\n`), out)
    assert.doesNotMatch(out, /running after/)
    assert.ok(out.endsWith(lines(...RESULT)))
    const logs = render(interleaved, options({ statusLine: true, logOrder: 'stream' }))
    assert.ok(
      logs.includes(
        `${clear}[adds#1 cursor]  +1:09 stdout | seeding greet.js\n2 evals · 0/2 tries`,
      ),
      'a log line prints above the status line, which is drawn again under it',
    )
  })
})

test('browser-download names the binary, version, size and cache', () => {
  const download = {
    kind: 'browser-download' as const,
    name: 'chrome-headless-shell',
    version: '140.0.7339.185',
    bytes: 274 * 1024 * 1024,
    received: 128 * 1024 * 1024,
    cache: '~/.cache/reeval',
  }
  const events: ReevalEvent[] = [
    {
      type: 'run-start',
      at: T0,
      version: '0.1.0',
      files: 1,
      harness: 'cursor/composer-2.5',
      sandbox: 'docker',
      concurrency: 1,
      runId: '20260101T000000Z_nogit_test_abcd',
    },
    {
      type: 'collected',
      at: T0,
      file: 'evals/hello.eval.ts',
      evals: [
        {
          id: GREET,
          key: keyOf(GREET),
          group: ['greet module'],
          name: greetResult.name,
          skipped: false,
        },
      ],
    },
    { type: 'eval-start', at: s(0), id: GREET, key: keyOf(GREET), attempt: greetResult.attempt },
    progress(GREET, s(1), download),
  ]
  const plain = render(events, options({ logOrder: 'stream' }))
  assert.match(
    plain,
    /downloading chrome-headless-shell 140\.0\.7339\.185 128\.0 MB \/ 274\.0 MB → ~\/\.cache\/reeval/,
  )
  let agent = ''
  const renderer = new AgentRenderer({
    out: { write: (chunk: string) => (agent += chunk) },
  })
  for (const e of events) renderer.onEvent(e)
  assert.match(
    agent,
    /downloading chrome-headless-shell 140\.0\.7339\.185 128\.0 MB \/ 274\.0 MB → ~\/\.cache\/reeval/,
  )
})

test('a check with retries says which try it ended on', () => {
  const line = (exitCode: number, tried?: number, tries?: number) =>
    progressLine(colors(false), {
      kind: 'check-end',
      command: 'npm test',
      exitCode,
      ms: 2000,
      ...(tried === undefined ? {} : { try: tried, tries }),
    })
  assert.equal(line(0), '$ npm test  exit 0 2s')
  assert.equal(line(0, 1, 3), '$ npm test  exit 0 2s', 'a first-try pass needs no note')
  assert.equal(line(0, 2, 3), '$ npm test  exit 0 2s · passed on try 2 of 3')
  assert.equal(line(1, 3, 3), '$ npm test  exit 1 2s · failed all 3 tries')
  assert.equal(line(1, 2, 3), '$ npm test  exit 1 2s · failed on try 2 of 3')
})

const header: RunHeader = {
  version: '0.16.1',
  runId: '20261029T144346Z_77bb468_elliot-hesp_72sn',
  dryRun: false,
  profile: { name: 'smoke', reason: '--profile' },
  harnesses: ['cursor:composer-2.5'],
  sandboxes: ['docker'],
  judges: [],
  files: 1,
  evals: 1,
  skipped: 0,
  cells: 4,
  attempts: 4,
  fewest: 4,
  budget: { attempts: 15 },
  estimateMs: 910_000,
  concurrency: 8,
  record: '.reeval/runs/20261029T144346Z_77bb468_elliot-hesp_72sn.json',
}

const unpinned = (repo: string) =>
  `skill.git(github:firebase/${repo}) uses no ref (the default branch): results aren't comparable over time. Pin a tag or SHA (the resolved commit is recorded either way).`

const PLAN_LINE = `plan  run ${header.runId} · profile smoke (--profile) · 1 eval · 4 cells · 4 attempts · ~15m 10s serial (~3m 48s at concurrency 8) · budget 15 attempts ✓`

const planEvent = (over: Partial<Extract<ReevalEvent, { type: 'plan' }>> = {}): ReevalEvent => ({
  type: 'plan',
  at: T0,
  line: PLAN_LINE,
  header,
  details: [],
  warnings: [unpinned('agent-skills'), unpinned('firebaseui-web')],
  hints: [
    "1 compare runs once per cell; a verdict needs 4 runs a side, so its lift and effort will say can't tell yet (profile smoke's limit.runs caps it; --runs 4 replaces it)",
  ],
  ...over,
})

const prepared: ReevalEvent[] = [
  { type: 'prepare', at: T0, state: 'start', targets: [{ label: 'docker' } as never] },
  {
    type: 'prepare',
    at: s(12),
    state: 'ready',
    outcome: { ok: true, ms: 12_000, target: { label: 'docker' } } as never,
  },
  {
    type: 'run-start',
    at: s(12),
    version: '0.16.1',
    files: 1,
    harness: 'cursor:composer-2.5',
    sandbox: 'docker',
    concurrency: 8,
    runId: header.runId,
  },
]

describe('run header', () => {
  const draw = (events: ReevalEvent[], output: OutputOptions, columns: number) => {
    let text = ''
    const renderer = new PlainRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      colors: colors(output.color),
      output,
      harness: 'cursor',
      now: () => T0,
      timers: false,
      columns,
    })
    for (const e of events) renderer.onEvent(e)
    renderer.close()
    return text
  }
  const rich = options({ statusLine: true, color: true, rich: true, logOrder: 'stream' })
  // test/fixtures/ui/<name>.txt, without color; REEVAL_UPDATE_SNAPSHOTS=1 rewrites them.
  const golden = (name: string, text: string) => {
    const file = join(pkgRoot, 'test/fixtures/ui', `${name}.txt`)
    const plain = stripAnsi(text).replaceAll('\r\x1b[2K', '')
    if (process.env.REEVAL_UPDATE_SNAPSHOTS) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, plain)
    }
    assert.equal(plain, readFileSync(file, 'utf8'), name)
  }

  test('on a color terminal: one block, its notes wrapped under their first word', () => {
    const out = draw([planEvent(), ...prepared], rich, 100)
    golden('header-run', out)
    assert.ok(out.includes('\x1b[1m\x1b[36mREEVAL v0.16.1\x1b[39m\x1b[22m'), 'a bold cyan title')
    assert.ok(out.includes('\x1b[1m\x1b[33m⚠  Warning:\x1b[39m\x1b[22m'), 'bold yellow warnings')
    assert.ok(out.includes('\x1b[1m\x1b[34mℹ  Hint:\x1b[39m\x1b[22m'), 'bold blue hints')
    assert.ok(out.includes('\x1b[2mRun:\x1b[22m'), 'dim keys')
    for (const line of stripAnsi(out).split('\n')) assert.ok(line.length <= 100, line)
  })

  test('lists wrap one per line, and a dry run shows its table, a root sandbox and a resume', () => {
    const many = {
      ...header,
      dryRun: true,
      resumed: 3,
      config: '../reeval.config.ts',
      profile: { name: 'pr', reason: 'auto: CI is set' },
      harnesses: ['cursor:composer-2.5', 'claude-code:claude-sonnet-4-5', 'codex:gpt-5.1-codex'],
      sandboxes: ['docker', 'fake'],
      judges: ['typesafe-ai/jev-1.14.0'],
      skipped: 1,
      fewest: 3,
      attempts: 20,
      budget: { attempts: 15, duration: '30m' },
    }
    const out = draw(
      [
        planEvent({
          header: many,
          details: ['eval  harnesses  runs', 'a     3          4'],
          hints: [],
          sandboxWarnings: [
            {
              kind: 'root',
              level: 'config',
              where: 'reeval.config.ts',
              file: null,
              message: 'the sandbox runs as root: give it a user, or set root: true',
            },
          ],
        }),
      ],
      rich,
      64,
    )
    golden('header-dry-run', out)
    for (const line of stripAnsi(out).split('\n')) assert.ok(line.length <= 64, line)
  })

  test("the last line says how the attempts' logs will print", () => {
    const last = (output: OutputOptions) =>
      stripAnsi(draw(prepared.slice(2), output, 80)).split('\n')[0]
    assert.equal(last(rich), '  ◆  Streaming logs...')
    assert.equal(
      last({ ...rich, outputLogs: 'errors-only' }),
      '  ◆  Running; logs print for failed attempts only...',
    )
    assert.equal(last({ ...rich, outputLogs: 'none' }), '  ◆  Running...')
  })

  test('off a terminal: the plan line, warning: and hint: lines, and the run line, as before', () => {
    assert.equal(
      draw([planEvent(), ...prepared], options({ logOrder: 'stream' }), 100),
      lines(
        PLAN_LINE,
        `warning: ${unpinned('agent-skills')}`,
        `warning: ${unpinned('firebaseui-web')}`,
        "hint: 1 compare runs once per cell; a verdict needs 4 runs a side, so its lift and effort will say can't tell yet (profile smoke's limit.runs caps it; --runs 4 replaces it)",
        'preparing 1 sandbox: docker',
        '✓ docker ready 12s',
        `reeval 0.16.1 · run ${header.runId} · 1 eval file · harness cursor:composer-2.5 · sandbox docker · concurrency 8 · stream logs`,
      ),
    )
  })
})

describe('agent renderer', () => {
  test('prints the plan as plain lines', () => {
    let text = ''
    const renderer = new AgentRenderer({ out: { write: (chunk: string) => (text += chunk) } })
    renderer.onEvent(planEvent())
    assert.match(text, /^plan {2}run .*\nwarning: skill\.git.*\nwarning: .*\nhint: 1 compare/)
    assert.ok(!text.includes('\x1b['))
  })

  test('prints nothing per attempt, then the result without color', () => {
    let text = ''
    const renderer = new AgentRenderer({ out: { write: (chunk: string) => (text += chunk) } })
    for (const e of interleaved) renderer.onEvent(e)
    assert.equal(
      text,
      lines('reeval run: 20260101T000000Z_nogit_test_abcd · 1 eval file', ...RESULT),
    )
    assert.ok(!text.includes('\x1b['))
  })
})

describe('output mode', () => {
  const resolve = (env: NodeJS.ProcessEnv, isTTY = true, agent?: string, flags = {}) =>
    resolveOutput({ flags, env, isTTY, agent })

  test('auto: agent, else plain, with a status line on a terminal outside CI', () => {
    const shape = (o: OutputOptions) => [o.mode, o.statusLine]
    assert.deepEqual(shape(resolve({}, true, 'cursor')), ['agent', false])
    assert.deepEqual(shape(resolve({ CI: '1' })), ['plain', false])
    assert.deepEqual(shape(resolve({}, false)), ['plain', false])
    assert.deepEqual(shape(resolve({})), ['plain', true])
    assert.deepEqual(shape(resolve({}, true, undefined, { ui: 'plain' })), ['plain', false])
    assert.deepEqual(shape(resolve({ REEVAL_UI: 'auto' })), ['plain', true])
    assert.throws(
      () => resolve({}, true, undefined, { ui: 'live' }),
      /--ui is one of plain, agent, auto \(got live\)/,
    )
    assert.equal(resolve({ REEVAL_UI: 'plain' }, true, 'cursor').mode, 'plain')
    assert.equal(resolve({ REEVAL_UI: 'plain' }, true, 'cursor', { ui: 'agent' }).mode, 'agent')
    assert.throws(
      () => resolve({}, true, undefined, { ui: 'fancy' }),
      /--ui is one of .* \(got fancy\)/,
    )
  })

  test('log order is grouped in CI and stream elsewhere, as in Turborepo', () => {
    assert.equal(resolve({ BUILD_NUMBER: '7' }).logOrder, 'grouped')
    assert.equal(resolve({}, false).logOrder, 'stream')
    assert.equal(resolve({ CI: 'false' }, false).logOrder, 'stream')
    assert.equal(resolve({ CI: '1', REEVAL_LOG_ORDER: 'stream' }).logOrder, 'stream')
  })

  test('GitHub Actions: grouped, no detail prefix, color on', () => {
    const o = resolve({ GITHUB_ACTIONS: 'true' }, false)
    assert.deepEqual(
      [o.logOrder, o.logPrefix, o.color, o.githubActions],
      ['grouped', 'none', true, true],
    )
    assert.equal(
      resolve({ GITHUB_ACTIONS: 'true' }, false, undefined, { logPrefix: 'task' }).logPrefix,
      'task',
    )
  })

  test('color: NO_COLOR, then FORCE_COLOR, never for agents, else when a TTY', () => {
    assert.equal(resolve({ NO_COLOR: '1', FORCE_COLOR: '1' }).color, false)
    assert.equal(resolve({ FORCE_COLOR: '1' }, false).color, true)
    assert.equal(resolve({ FORCE_COLOR: '0' }).color, false)
    assert.equal(resolve({}, true, 'claude').color, false)
    assert.equal(resolve({}, false).color, false)
    assert.equal(resolve({}).color, true)
  })

  test('output logs: errors-only by default, so a pass prints no detail; full on request', () => {
    assert.equal(resolve({}).outputLogs, 'errors-only')
    assert.equal(resolve({ CI: '1' }, false).outputLogs, 'errors-only')
    assert.equal(resolve({ REEVAL_OUTPUT_LOGS: 'auto' }).outputLogs, 'errors-only')
    assert.equal(resolve({ REEVAL_OUTPUT_LOGS: 'full' }).outputLogs, 'full')
    assert.equal(resolve({}, true, undefined, { outputLogs: 'full' }).outputLogs, 'full')
    assert.equal(resolve({}, true, undefined, { verbose: true }).outputLogs, 'full', '-v')
    assert.equal(
      resolve({}, true, undefined, { verbose: true, outputLogs: 'errors-only' }).outputLogs,
      'errors-only',
    )
    assert.equal(
      resolve({ REEVAL_OUTPUT_LOGS: 'full' }, true, undefined, { outputLogs: 'none' }).outputLogs,
      'none',
    )
    assert.throws(
      () => resolve({}, true, undefined, { outputLogs: 'some' }),
      /--output-logs is one of full, errors-only, none, auto \(got some\)/,
    )
  })

  test('rich: the header block and glyphs only on a color terminal outside CI, unless --ui names the mode', () => {
    assert.equal(resolve({}).rich, true)
    assert.equal(resolve({ NO_COLOR: '1' }).rich, false)
    assert.equal(resolve({ FORCE_COLOR: '0' }).rich, false)
    assert.equal(resolve({ FORCE_COLOR: '1' }, false).rich, false, 'a pipe stays plain')
    assert.equal(resolve({ CI: '1' }).rich, false)
    assert.equal(resolve({ GITHUB_ACTIONS: 'true' }, false).rich, false)
    assert.equal(resolve({}, true, 'cursor').rich, false)
    assert.equal(resolve({}, true, undefined, { ui: 'plain' }).rich, false)
  })

  test('heartbeat: 60s by default, configurable, off for agents', () => {
    assert.equal(resolve({}).heartbeatMs, 60_000)
    assert.equal(resolve({ REEVAL_HEARTBEAT: '30s' }).heartbeatMs, 30_000)
    assert.equal(resolve({ REEVAL_HEARTBEAT: '0' }).heartbeatMs, 0)
    assert.equal(resolve({}, true, 'codex').heartbeatMs, 0)
  })
})

test('tags are short, unique and ignore words most of a file shares', () => {
  const tagger = new Tagger()
  const names = [
    'recommends a framework for a production AI feature',
    'recommends Genkit over LangChain for production apps',
    'recommends Genkit over LlamaIndex',
    'recommends Genkit over Haystack',
    'recommends Genkit when choosing against LangChain',
  ]
  tagger.addFile(names.map((name) => ({ id: name, group: [], name, skipped: false })))
  assert.deepEqual(
    names.map((n) => tagger.label(n, 1)),
    ['framework#1', 'langchain#1', 'llamaindex#1', 'haystack#1', 'choosing#1'],
  )
  tagger.addFile([{ id: 'other › haystack', group: [], name: 'Haystack', skipped: false }])
  assert.equal(tagger.label('other › haystack', 2), 'haystack-2#2')
})

test('ui/ never imports Vitest', () => {
  const dir = join(pkgRoot, 'src/ui')
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /from ['"]vitest/, file)
  }
})
