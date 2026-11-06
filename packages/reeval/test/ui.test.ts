import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { render as inkRender } from 'ink-testing-library'
import { createElement as h } from 'react'
import { attach } from '../src/attach.ts'
import { EventStreamError, openEventStream } from '../src/events.ts'
import type { RunRecord } from '../src/history/types.ts'
import { writeLiveProgress } from '../src/live.ts'
import type { AttemptMeta } from '../src/types.ts'
import { AgentRenderer } from '../src/ui/agent.ts'
import { type ColorDepth, colors, stripAnsi } from '../src/ui/colors.ts'
import type { EvalResult, Progress, ReevalEvent, RunHeader } from '../src/ui/events.ts'
import { failureReason, phaseOf, progressLine } from '../src/ui/format.ts'
import { createRenderer } from '../src/ui/index.ts'
import { ListApp } from '../src/ui/ink-list.ts'
import { type OutputOptions, resolveOutput } from '../src/ui/mode.ts'
import { PlainRenderer } from '../src/ui/plain.ts'
import { Tagger } from '../src/ui/tags.ts'
import { InteractiveRenderer, type ListStore } from '../src/ui/tty.ts'
import { readableRecord } from '../src/view/record.ts'
import type { RunRemarks } from '../src/view/remarks.ts'
import { pkgRoot, tempDir } from './helpers.ts'
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
  errorName: 'AssertionError',
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
    filesChanged: 2,
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
    filesChanged: 1,
  }),
  progress(DEFAULT, s(200), { kind: 'turn-start', turn: 2 }),
  progress(DEFAULT, s(330), {
    kind: 'turn-end',
    turn: 2,
    status: 'completed',
    ms: 130_000,
    tools: 2,
    fileEdits: 1,
    filesChanged: 1,
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
  githubActions: false,
  heartbeatMs: 60_000,
  interactive: false,
  ...overrides,
})

/** Feeds events to a renderer on a fake non-TTY stream, ticking the heartbeat between them. */
function render(
  events: ReevalEvent[],
  output: OutputOptions,
  color = false,
  verbosity: 0 | 1 = 0,
): string {
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
    verbosity,
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

const LIST = [
  ['✓ writes greet.js              1 of 1 run passed'],
  [
    '✗ greets in French             0 of 1 run passed',
    'Failed on fake.',
    '✗ french greeting  failed 1 of 1 run',
    '  expected command to succeed, exit code 1',
  ],
  [
    '✗ explains why greet.js fails  1 of 2 runs passed',
    'Passed 1 of 2 on fake.',
    '✗ names the root cause  failed 1 of 2 runs',
    "  expected 'Docker is down' to contain 'null'",
  ],
  [
    '✗ reads the fixture repo       0 of 1 run passed',
    'Failed on fake.',
    '✗ 1 run failed',
    '  the fixture repo is missing',
  ],
  [
    '✗ starts its sandbox           0 of 1 run passed',
    'No run finished.',
    '✗ 1 run hit an infrastructure error',
    '  the fake sandbox fell over',
  ],
  ['– greets in Welsh              skipped'],
  ['– greets in Klingon            todo'],
]

/** The status list `run-end` prints, with the tree's glyphs (pipe and CI) or without (agent mode). */
const result = (glyphs: boolean) => [
  '',
  'evals/results.eval.ts',
  ...LIST.flatMap(([row = '', ...detail], i) => {
    const last = i === LIST.length - 1
    const branch = glyphs ? (last ? '└─ ' : '├─ ') : '  '
    const indent = glyphs ? (last ? '     ' : '│    ') : '    '
    return [`${branch}${row}`, ...detail.map((line) => `${indent}${line}`)]
  }),
  '',
  'Done in 6m 05s · 3 failed · 1 infra error · 1 passed · 2 skipped',
  'Browse it: reeval studio · summary .reeval/runs/run-1/summary.md',
]

const RESULT = result(true)

/** `interleaved` with a two-line failure message, whose second line is `-v` detail. */
const withLongMessage = JSON.parse(
  JSON.stringify(interleaved).replaceAll(
    'french greeting: expected command to succeed, exit code 1\\n',
    'french greeting: expected command to succeed, exit code 1\\nthe clone found no commits\\n',
  ),
) as ReevalEvent[]

describe('plain renderer', () => {
  test('grouped: start lines stream, each attempt prints as one block when it ends', () => {
    assert.equal(
      render(interleaved, options()),
      lines(
        "  ◆  Running; each attempt's logs print as it ends...",
        '',
        '… 2 running after 1m 00s: [creates#1 cursor] agent turn 1 1m 00s, [adds#1 cursor] agent turn 1 59s',
        '… 2 running after 2m 00s: [creates#1 cursor] agent turn 1 2m 00s, [adds#1 cursor] agent turn 1 1m 59s',
        '… 2 running after 3m 00s: [creates#1 cursor] cleanup 3m 00s, [adds#1 cursor] agent turn 1 2m 59s',
        '[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
        '[creates#1 cursor]  +0:01 sandbox ready 4s',
        '[creates#1 cursor]  +0:05 turn 1 done 2m 45s · 6 tool calls, 2 files changed',
        '[creates#1 cursor]  +2:50 $ node --test  exit 0 1s',
        '[creates#1 cursor]  +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '… 1 running after 4m 12s: [adds#1 cursor] agent turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] agent turn 2 5m 11s',
        '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
        '[adds#1 cursor]  +0:01 sandbox ready 4s',
        '[adds#1 cursor]  +0:05 turn 1 done 3m 14s · 3 tool calls, 1 file changed',
        '[adds#1 cursor]  +1:09 stdout | seeding greet.js',
        '[adds#1 cursor]  +3:19 turn 2 done 2m 10s · 2 tool calls, 1 file changed',
        '[adds#1 cursor]  +5:29 $ node -e "…"…  exit 1 900ms',
        '[adds#1 cursor]  ✗ failed  expected 1 to be 2 // Object.is equality',
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

  test('a gateway that names its upstreams: the list says who served the agent and the judge', () => {
    const served: RunRecord = {
      ...record,
      evals: record.evals.map((e) =>
        e.name !== 'writes greet.js'
          ? e
          : {
              ...e,
              attempts: e.attempts.map((a) => ({
                ...a,
                upstreams: [
                  { provider: 'Anthropic', calls: 2 },
                  { provider: 'Amazon Bedrock', calls: 1 },
                ],
                judgements: [
                  {
                    question: 'Accurate summary?',
                    verdict: 'pass' as const,
                    score: 0.9,
                    threshold: 0.8,
                    model: 'openrouter/google/gemini-2.5-flash',
                    gateway: 'openrouter',
                    upstream: 'Google',
                  },
                ],
              })),
            },
      ),
    }
    const events = interleaved.map((e) => (e.type === 'run-end' ? { ...e, record: served } : e))
    const out = render(events, options()).split('\n')
    const row = out.findIndex((l) => l.startsWith('├─ ✓ writes greet.js'))
    assert.deepEqual(out.slice(row, row + 3), [
      '├─ ✓ writes greet.js              1 of 1 run passed',
      '│    Passed on fake.',
      '│    Worth knowing: served by Anthropic 2 · Amazon Bedrock 1; judge served by Google 1',
    ])
  })

  test('stream: every prefixed line prints as it happens, interleaved', () => {
    const out = render(interleaved, options({ logOrder: 'stream' })).split('\n')
    assert.deepEqual(out.slice(2, 17), [
      '[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
      '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
      '[creates#1 cursor]  +0:01 sandbox starting',
      '[adds#1 cursor]  +0:01 sandbox starting',
      '[creates#1 cursor]  +0:05 sandbox ready 4s',
      '[creates#1 cursor]  +0:05 turn 1 started',
      '[adds#1 cursor]  +0:05 sandbox ready 4s',
      '[adds#1 cursor]  +0:05 turn 1 started',
      '… 2 running after 1m 06s: [creates#1 cursor] agent turn 1 1m 06s, [adds#1 cursor] agent turn 1 1m 05s',
      '[adds#1 cursor]  +1:09 stdout | seeding greet.js',
      '… 2 running after 2m 10s: [creates#1 cursor] agent turn 1 2m 10s, [adds#1 cursor] agent turn 1 2m 09s',
      '[creates#1 cursor]  +2:50 turn 1 done 2m 45s · 6 tool calls, 2 files changed',
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
        ' +0:05 turn 1 done 2m 45s · 6 tool calls, 2 files changed',
        ' +2:50 $ node --test  exit 0 1s',
        ' +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '::endgroup::',
        '… 1 running after 4m 12s: [adds#1 cursor] agent turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] agent turn 2 5m 11s',
        '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
        ' +0:01 sandbox ready 4s',
        ' +0:05 turn 1 done 3m 14s · 3 tool calls, 1 file changed',
        ' +1:09 stdout | seeding greet.js',
        ' +3:19 turn 2 done 2m 10s · 2 tool calls, 1 file changed',
        ' +5:29 $ node -e "…"…  exit 1 900ms',
        ' ✗ failed  expected 1 to be 2 // Object.is equality',
        '',
        ' - Expected',
        ' + Received',
        '',
        ' - 2',
        ' + 1',
        '',
        '  ❯ evals/hello.eval.ts:31:20',
        '::error file=evals/hello.eval.ts,line=31,col=20,title=evals/hello.eval.ts › greet module › adds a default name in a follow-up turn::expected 1 to be 2 // Object.is equality%0A%0A- Expected%0A+ Received%0A%0A- 2%0A+ 1%0A%0A ❯ evals/hello.eval.ts:31:20',
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
      ' ✗ failed  tests pass: expected command to succeed, exit code 1  evals/hello.eval.ts:33',
      ' ✗ failed  names it: expected 1 to be 3',
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
      errorName: 'Error',
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
      // The failed check is the error itself, so it prints once, as the attempt's failure.
      [clipped, 1, 1],
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
      assert.equal(out, lines('  ◆  Running...', ...RESULT))
    }
    assert.doesNotMatch(render(interleaved, options({ logOrder: 'stream' })), / [✓✗] evals\//)
  })

  test('with no attempt logs, a pipe gets a progress line on the heartbeat and the list at the end', () => {
    const out = render(interleaved, options({ outputLogs: 'none' })).split('\n')
    assert.deepEqual(
      out.filter((line) => line.startsWith('…')),
      [
        '… 0 of 2 evals done (1m 00s)',
        '… 0 of 2 evals done (2m 00s)',
        '… 0 of 2 evals done (3m 00s)',
        '… 1 of 2 evals done (4m 00s)',
        '… 1 of 2 evals done (5m 00s)',
        '… 1 of 2 evals done (6m 00s)',
      ],
    )
    assert.ok(out.join('\n').endsWith(lines(...RESULT)))
  })

  test('on a terminal: one status line under the logs, rewritten in place, cleared before the result', () => {
    const out = render(interleaved, options({ statusLine: true, outputLogs: 'none' }))
    const clear = '\r\x1b[2K'
    assert.ok(out.includes(`${clear}2 evals · 0/2 tries`), out)
    assert.ok(out.includes(`${clear}2 evals · 1/2 tries`), out)
    assert.ok(out.includes(`  ◆  Running...\n\n${clear}2 evals · 0/2 tries`), out)
    assert.ok(
      out.includes(`${clear}2 evals · 2/2 tries${clear}evals/`),
      'no second gap above the list',
    )
    assert.doesNotMatch(out, /running after/)
    assert.ok(out.endsWith(lines(...RESULT.slice(1))))
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
    output: options({ mode: 'agent' }),
  })
  for (const e of events) renderer.onEvent(e)
  assert.match(
    agent,
    /downloading chrome-headless-shell 140\.0\.7339\.185 128\.0 MB \/ 274\.0 MB → ~\/\.cache\/reeval/,
  )
})

test("a gateway warning prints as it happens, in the plain and agent output, on the attempt's line", () => {
  const text =
    "the egress gateway refused POST https://api.openai.com/v1/alpha/search: it carries OPENAI_API_KEY's placeholder and isn't one of the endpoints reeval brokers it for"
  const events: ReevalEvent[] = [
    {
      type: 'run-start',
      at: T0,
      version: '0.1.0',
      files: 1,
      harness: 'codex/gpt-5.5',
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
    progress(GREET, s(1), { kind: 'turn-start', turn: 1 }),
    progress(GREET, s(2), { kind: 'warning', text }),
  ]
  const warned = /\] {2}\+0:02 warning: the egress gateway refused POST https:\/\/api\.openai/
  const plain = render(events, options({ logOrder: 'stream' }))
  assert.match(plain, warned)
  // Grouped with errors-only, the attempt's block prints only if it fails; the warning doesn't wait.
  const grouped = render(events, options({ logOrder: 'grouped', outputLogs: 'errors-only' }))
  assert.match(grouped, warned)
  assert.doesNotMatch(grouped, /turn 1 started/, 'the rest of the block is held')
  let agent = ''
  const renderer = new AgentRenderer({
    out: { write: (chunk: string) => (agent += chunk) },
    output: options({ mode: 'agent' }),
  })
  for (const e of events) renderer.onEvent(e)
  assert.ok(
    agent.split('\n').some((l) => /^\[\w+#1 \S+\] warning: /.test(l) && l.endsWith(text)),
    agent,
  )
  assert.equal(phaseOf({ at: s(2), kind: 'warning', text }), 'running')
})

test("an attempt's failure in a line: the message without a plain Error's class, the judge's verdict, or canceled", () => {
  assert.equal(failureReason(defaultResult), 'expected 1 to be 2 // Object.is equality')
  assert.equal(
    failureReason({
      ...defaultResult,
      errors: ['Error: the fixture is missing\n    at evals/a.eval.ts:3'],
    }),
    'the fixture is missing',
  )
  assert.equal(
    failureReason({
      ...defaultResult,
      errors: ['TypeError: x is undefined\n    at evals/a.eval.ts:3'],
    }),
    'TypeError: x is undefined',
    'a TypeError keeps its class: the eval itself broke',
  )
  const judged: EvalResult = {
    ...defaultResult,
    meta: {
      outcome: 'fail',
      errorKind: 'judge',
      judgements: [{ verdict: 'fail', score: 0.3, threshold: 0.8, question: 'ok?' }],
      recordPath: '',
    },
  }
  assert.match(failureReason(judged), /0\.30.*0\.8.*ok\?/)
  const aborted: EvalResult = {
    ...defaultResult,
    meta: { outcome: 'fail', errorKind: 'aborted', judgements: [], recordPath: '' },
  }
  assert.equal(failureReason(aborted), 'canceled')
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
  efforts: { 'cursor:composer-2.5': 'none' },
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

const PLAN_LINE = `plan  run ${header.runId} · profile smoke (--profile) · 1 eval · 4 cells · 4 attempts · effort none · ~15m 10s serial (~3m 48s at concurrency 8) · budget 15 attempts ✓`

const planEvent = (over: Partial<Extract<ReevalEvent, { type: 'plan' }>> = {}): ReevalEvent => ({
  type: 'plan',
  at: T0,
  line: PLAN_LINE,
  header,
  details: [],
  warnings: [unpinned('agent-skills'), unpinned('firebaseui-web')],
  hints: [
    "1 compare runs once per cell; below 4 runs a side its lift shows only a direction and its effort can't be tested (profile smoke's limit.runs caps it; --runs 4 replaces it)",
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

const draw = (
  events: ReevalEvent[],
  output: OutputOptions,
  columns: number,
  depth: ColorDepth = 4,
) => {
  let text = ''
  const renderer = new PlainRenderer({
    out: { write: (chunk: string) => (text += chunk) },
    colors: colors(output.color, depth),
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
const rich = options({ statusLine: true, color: true, logOrder: 'stream' })

describe('run header', () => {
  // test/fixtures/ui/<name>.txt, without color, or with its codes and ESC as ␛;
  // REEVAL_UPDATE_SNAPSHOTS=1 rewrites them.
  const golden = (name: string, text: string, keepColor = false) => {
    const file = join(pkgRoot, 'test/fixtures/ui', `${name}.txt`)
    const shown = text.replaceAll('\r\x1b[2K', '')
    const plain = keepColor ? shown.replaceAll('\x1b', '␛') : stripAnsi(shown)
    if (process.env.REEVAL_UPDATE_SNAPSHOTS) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, plain)
    }
    assert.equal(plain, readFileSync(file, 'utf8'), name)
  }

  test('on a color terminal: one block, its notes wrapped under their first word', () => {
    const out = draw([planEvent(), ...prepared], rich, 100)
    golden('header-run', out)
    assert.ok(
      out.startsWith('\x1b[1mREEVAL v0.16.1\x1b[22m'),
      'on 16 colors, a bold title in the text color',
    )
    assert.ok(
      out.includes('\x1b[33m⚠\x1b[39m  \x1b[1mWarning:\x1b[22m'),
      'on 16 colors, a yellow glyph and a bold label in the text color',
    )
    assert.ok(out.includes('\x1b[36mℹ\x1b[39m  \x1b[1mHint:\x1b[22m'), 'and a cyan glyph for hints')
    assert.ok(out.includes('\x1b[2mRun:\x1b[22m'), 'dim keys')
    for (const line of stripAnsi(out).split('\n')) assert.ok(line.length <= 100, line)
  })

  test('with 256 colors or truecolor, warnings are orange and the accents mid-tone', () => {
    const at = (depth: ColorDepth) => draw([planEvent(), ...prepared], rich, 100, depth)
    golden('header-run-256', at(8), true)
    assert.ok(at(8).includes('\x1b[1m\x1b[38;5;166m⚠  Warning:\x1b[39m\x1b[22m'))
    assert.ok(at(8).includes('\x1b[1m\x1b[38;5;33mℹ  Hint:\x1b[39m\x1b[22m'))
    assert.ok(at(8).includes('\x1b[38;5;31m➜\x1b[39m'))
    assert.ok(at(8).startsWith('\x1b[1m\x1b[38;5;31mREEVAL v0.16.1\x1b[39m\x1b[22m'))
    assert.ok(at(24).includes('\x1b[1m\x1b[38;2;215;95;0m⚠  Warning:\x1b[39m\x1b[22m'))
    assert.ok(at(24).includes('\x1b[38;2;0;135;175m◆\x1b[39m'))
    assert.equal(stripAnsi(at(24)), stripAnsi(at(4)), 'only the colors differ')
  })

  test('lists wrap one per line, and a dry run shows its table, a root sandbox and a resume', () => {
    const many = {
      ...header,
      dryRun: true,
      resumed: 3,
      retried: 2,
      config: '../reeval.config.ts',
      profile: { name: 'pr', reason: 'auto: CI is set' },
      harnesses: ['cursor:composer-2.5', 'claude-code:claude-haiku-4-5', 'codex:gpt-5.1-codex'],
      efforts: {
        'cursor:composer-2.5': 'not checked',
        'claude-code:claude-haiku-4-5': 'none',
        'codex:gpt-5.1-codex': 'medium',
      },
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

  test('on a narrow terminal, a wrapped row never starts with a separator', () => {
    const shown = (columns: number) =>
      stripAnsi(draw([planEvent({ warnings: [], hints: [] })], rich, columns)).split('\n')
    const scope = shown(36).filter((l) => l.startsWith(' '.repeat(16)))
    assert.ok(scope.length > 1, 'the scope and estimate rows wrap')
    for (const columns of [36, 40, 48, 60])
      for (const line of shown(columns)) assert.doesNotMatch(line, /^\s*·/, line)
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

  test('off a terminal (a pipe, CI, --ui plain): the same header block, without color', () => {
    const events = [planEvent(), ...prepared]
    const piped = draw(events, options({ logOrder: 'stream' }), 100)
    assert.equal(piped, stripAnsi(draw(events, rich, 100)))
    assert.ok(!piped.includes('\x1b['))
    assert.match(piped, /^REEVAL v0\.16\.1\n/)
    assert.match(piped, /\n {2}◆ {2}Streaming logs\.\.\.\n/)
  })
})

describe('agent renderer', () => {
  test('prints the header block a terminal does, without color', () => {
    let text = ''
    const renderer = new AgentRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      output: options({ mode: 'agent' }),
    })
    renderer.onEvent(planEvent())
    assert.equal(text, stripAnsi(draw([planEvent()], rich, Number.POSITIVE_INFINITY)))
    assert.ok(!text.includes('\x1b['))
  })

  test('prints nothing per attempt, then the result without color', () => {
    let text = ''
    const renderer = new AgentRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      output: options({ mode: 'agent' }),
    })
    for (const e of interleaved) renderer.onEvent(e)
    assert.equal(text, lines('  ◆  Running...', ...result(false)))
    assert.ok(!text.includes('\x1b['))
  })

  test('prints the detail a terminal keeps behind -v, since an agent acts on it', () => {
    let text = ''
    const renderer = new AgentRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      output: options({ mode: 'agent' }),
    })
    for (const e of withLongMessage) renderer.onEvent(e)
    assert.match(text, /^ {6}the clone found no commits$/m)
    assert.ok(
      !render(withLongMessage, options({ outputLogs: 'none' })).includes('found no commits'),
      'a pipe keeps it for -v',
    )
  })
})

describe('interactive renderer', () => {
  const interactive = (load: () => Promise<never>, verbosity: 0 | 1 = 0) => {
    let text = ''
    const out = {
      isTTY: true,
      write: (chunk: string) => {
        text += chunk
        return true
      },
    }
    const renderer = new InteractiveRenderer({
      out,
      stdout: out as never,
      stdin: {} as never,
      colors: colors(false),
      output: options({ statusLine: true, interactive: true, outputLogs: 'none' }),
      harness: 'cursor',
      now: () => T0,
      timers: false,
      load,
      verbosity,
    })
    return { renderer, text: () => text }
  }

  test('the prepare step spins, except under REEVAL_DEBUG, whose stderr lines it cannot count', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const step = (debug: string | undefined) => {
      const env = process.env.REEVAL_DEBUG
      if (debug === undefined) delete process.env.REEVAL_DEBUG
      else process.env.REEVAL_DEBUG = debug
      try {
        let text = ''
        const out = {
          isTTY: true,
          write: (chunk: string) => {
            text += chunk
            return true
          },
        }
        const renderer = new InteractiveRenderer({
          out,
          stdout: out as never,
          stdin: {} as never,
          colors: colors(false),
          output: options({ statusLine: true, interactive: true, outputLogs: 'none' }),
          harness: 'cursor',
          now: () => T0,
          load: () => new Promise<never>(() => {}),
        })
        renderer.onEvent({
          type: 'prepare',
          at: T0,
          state: 'start',
          targets: [{ label: 'docker' } as never],
        } as never)
        return text
      } finally {
        if (env === undefined) delete process.env.REEVAL_DEBUG
        else process.env.REEVAL_DEBUG = env
      }
    }
    assert.ok(step(undefined).includes('\x1b[1A'), 'the spinner draws on the step line')
    assert.ok(!step('1').includes('\x1b['), 'no cursor moves under REEVAL_DEBUG')
  })

  test('quitting the list leaves the whole list in the scrollback, as a pipe prints it', async () => {
    const { renderer, text } = interactive(
      async () =>
        ({
          mountList: () => ({ waitUntilExit: async () => {}, unmount: () => {} }),
        }) as never,
    )
    for (const e of interleaved) renderer.onEvent(e)
    renderer.close()
    await renderer.wait()
    assert.equal(text(), lines('  ◆  Finished.', ...RESULT))
  })

  test('under -v with --output-logs none, the scrollback is the list -v prints to a pipe', async () => {
    const mount = async () =>
      ({
        mountList: () => ({ waitUntilExit: async () => {}, unmount: () => {} }),
      }) as never
    const suggestion =
      'The greet.js check passes on every run, so it tells the arms apart on nothing.'
    const remarks: RunRemarks = {
      kind: 'reeval-remarks',
      schemaVersion: 1,
      runId: record.runId,
      createdAt: new Date(T0).toISOString(),
      remarks: [
        {
          id: 'never-fails',
          evalId: 'evals%2Fresults.eval.ts › writes greet.js',
          kind: 'check-never-fails',
          severity: 'suggestion',
          text: suggestion,
          evidence: [],
          fix: { at: 'source:evals/results.eval.ts#L4', edit: 'make the check stricter' },
          firstSeenRun: record.runId,
        },
      ],
    }
    const events = withLongMessage.map((e) => (e.type === 'run-end' ? { ...e, remarks } : e))
    const { renderer, text } = interactive(mount, 1)
    for (const e of events) renderer.onEvent(e)
    renderer.close()
    await renderer.wait()
    const piped = render(events, options({ outputLogs: 'none' }), false, 1)
    const list = (out: string) => out.slice(out.indexOf('evals/results.eval.ts'))
    assert.match(text(), /^│ {6}the clone found no commits$/m)
    assert.ok(text().includes(suggestion), 'a suggestion prints only under -v')
    assert.match(text(), /^ {2}◆ {2}Finished\.\n\nevals\/results\.eval\.ts/)
    assert.equal(list(text()), list(piped))
  })

  test("if Ink can't load, the run prints as a pipe's does, and wait resolves", async () => {
    const { renderer, text } = interactive(() =>
      Promise.reject(new Error("Cannot find package 'ink'")),
    )
    for (const e of interleaved) renderer.onEvent(e)
    await renderer.wait()
    renderer.close()
    assert.equal(
      text(),
      lines(
        'stdout | seeding greet.js',
        "Couldn't draw the interactive list (Cannot find package 'ink').",
        '  ◆  Finished.',
        ...RESULT,
      ),
    )
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

  test('interactive: the browsable list only with a status line, a terminal on stdin and no attempt logs', () => {
    const interactive = (env: NodeJS.ProcessEnv, stdinTTY: boolean, flags = {}) =>
      resolveOutput({ flags, env, isTTY: true, stdinTTY }).interactive
    assert.equal(interactive({}, true), true)
    assert.equal(interactive({}, false), false, 'stdin piped')
    assert.equal(interactive({ CI: '1' }, true), false)
    assert.equal(interactive({}, true, { verbose: true }), false, '-v streams the logs instead')
    assert.equal(interactive({}, true, { ui: 'plain' }), false)
    assert.equal(resolveOutput({ flags: {}, env: {}, isTTY: true }).interactive, false)
    assert.equal(
      resolveOutput({ flags: {}, env: {}, isTTY: true, stdinTTY: true, agent: 'cursor' })
        .interactive,
      false,
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

  test('output logs: none by default, since the eval list says how each went; full on request', () => {
    assert.equal(resolve({}).outputLogs, 'none')
    assert.equal(resolve({ CI: '1' }, false).outputLogs, 'none')
    assert.equal(resolve({ REEVAL_OUTPUT_LOGS: 'auto' }).outputLogs, 'none')
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

test('progress counts against the planned total while later files are still to be collected', () => {
  const planned = planEvent({
    header: { ...header, evals: 4, attempts: 4 },
    warnings: [],
    hints: [],
  })
  const events = [interleaved[0] as ReevalEvent, planned, ...interleaved.slice(1)]
  const beats = render(events, options({ outputLogs: 'none' }))
    .split('\n')
    .filter((line) => line.startsWith('…'))
  assert.equal(beats[0], '… 0 of 4 evals done (1m 00s)')
  assert.equal(beats.at(-1), '… 1 of 4 evals done (6m 00s)')
  const status = render(events, options({ statusLine: true, outputLogs: 'none' }))
  assert.ok(status.includes('\r\x1b[2K4 evals · 0/4 tries'), status)
  assert.doesNotMatch(status, /2 evals · \d\/2 tries/)
})

test('the interactive list counts against the planned total too', async () => {
  let store: ListStore | undefined
  const renderer = new InteractiveRenderer({
    out: { isTTY: true, write: () => true },
    stdout: {} as never,
    stdin: {} as never,
    colors: colors(false),
    output: options({ statusLine: true, interactive: true, outputLogs: 'none' }),
    harness: 'cursor',
    now: () => T0,
    timers: false,
    load: async () => ({
      mountList: (o) => {
        store = o.store
        return { waitUntilExit: () => new Promise(() => {}), unmount: () => {} }
      },
    }),
  })
  const planned = planEvent({
    header: { ...header, evals: 4, attempts: 4 },
    warnings: [],
    hints: [],
  })
  const collected = interleaved.find((e) => e.type === 'collected') as ReevalEvent
  for (const e of [interleaved[0] as ReevalEvent, planned, collected]) renderer.onEvent(e)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store?.get().counts.total, 4)
})

test('the interactive list takes a burst of events in one update, as attach replays a stream', async () => {
  let store: ListStore | undefined
  const renderer = new InteractiveRenderer({
    out: { isTTY: true, write: () => true },
    stdout: {} as never,
    stdin: {} as never,
    colors: colors(false),
    output: options({ statusLine: true, interactive: true, outputLogs: 'none' }),
    harness: 'cursor',
    now: () => T0,
    timers: false,
    load: async () => ({
      mountList: (o) => {
        store = o.store
        return { waitUntilExit: () => new Promise(() => {}), unmount: () => {} }
      },
    }),
  })
  for (const e of interleaved.slice(0, 3)) renderer.onEvent(e)
  await new Promise((resolve) => setImmediate(resolve))
  let updates = 0
  store?.subscribe(() => updates++)
  for (let turn = 1; turn <= 2000; turn++) {
    renderer.onEvent(progress(GREET, s(turn), { kind: 'turn-start', turn }))
  }
  assert.equal(updates, 0, 'nothing is drawn while the burst comes in')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updates, 1, 'one update for the whole burst')
  const detail = store?.get().files.flatMap((f) => f.rows.flatMap((r) => r.detail))
  assert.ok(
    detail?.some((l) => l.text.includes('turn 2000')),
    JSON.stringify(detail?.map((l) => l.text)),
  )
  renderer.close()
})

test("the interactive list opens an attempt's pane on what its events said: timeline, logs, errors", async () => {
  let store: ListStore | undefined
  const renderer = new InteractiveRenderer({
    out: { isTTY: true, write: () => true },
    stdout: {} as never,
    stdin: {} as never,
    colors: colors(false),
    output: options({ statusLine: true, interactive: true, outputLogs: 'none' }),
    harness: 'cursor',
    now: () => T0,
    timers: false,
    load: async () => ({
      mountList: (o) => {
        store = o.store
        return { waitUntilExit: () => new Promise(() => {}), unmount: () => {} }
      },
    }),
  })
  for (const e of interleaved.filter((e) => e.type !== 'run-end')) renderer.onEvent(e)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(store)
  const lines = store.get().attempts?.of(DEFAULT) ?? []
  assert.deepEqual(
    lines.map((l) => l.attempt),
    [keyOf(DEFAULT)],
    'its attempt line carries the key',
  )
  const app = inkRender(h(ListApp, { store, colors: colors(false), cancel: () => {} }))
  const frame = () => app.lastFrame() ?? ''
  try {
    await sleep(30)
    for (const key of ['\u001B[B', '\r', '\u001B[B', '\r']) {
      app.stdin.write(key)
      await sleep(30)
    }
    const top = frame()
    assert.match(top, /^greet module › adds a default name in a follow-up turn$/m)
    assert.match(top, /^ {2}✗ cursor #1 failed · expected 1 to be 2/m)
    for (const line of [
      /^ {4}\+0:00 {2}started$/m,
      /^ {4}\+0:01 {2}sandbox starting$/m,
      /^ {4}\+0:05 {2}sandbox ready 4s$/m,
      /^ {4}\+3:19 {2}turn 1 done 3m 14s · 3 tool calls, 1 file changed$/m,
      /^ {4}\+5:30 {2}\$ node -e "…"… {2}exit 1 900ms$/m,
      /^ {4}\+6:03 {2}failed 6m 03s$/m,
      /^ {4}seeding greet\.js$/m,
    ]) {
      assert.match(top, line)
    }
    assert.match(top, /↑↓ scroll · ← back · q cancel · lines 1–\d+ of \d+$/m)
    app.stdin.write('\u001B[F')
    await sleep(30)
    const pane = frame()
    for (const line of [
      /^ {4}AssertionError: expected 1 to be 2 \/\/ Object\.is equality$/m,
      /^ {4} ❯ evals\/hello\.eval\.ts:31:20$/m,
      /^ {4}The transcript isn't available in this view\.$/m,
    ]) {
      assert.match(pane, line)
    }
    assert.ok(!pane.includes('\x1b['), 'no color on a colorless terminal, errors included')
    assert.doesNotMatch(pane, /greet module › creates/, 'only this attempt')
  } finally {
    app.unmount()
    renderer.close()
  }
})

describe('reeval attach', () => {
  /** What a renderer draws from `events`, as `reeval run` feeds them. */
  const direct = (events: ReevalEvent[], output: OutputOptions, verbosity: 0 | 1 = 0) => {
    let text = ''
    const renderer = createRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      output,
      harness: 'cursor',
      verbosity,
    })
    for (const e of events) renderer.onEvent(e)
    renderer.close()
    return text
  }

  /** What `reeval attach` draws from the stream `reeval run --events` writes of `events`. */
  const attached = async (
    events: ReevalEvent[],
    output: OutputOptions,
    verbosity: 0 | 1 = 0,
    beats = false,
  ) => {
    const file = join(tempDir('ui-events'), 'events.ndjson')
    const stream = openEventStream({
      file,
      header: { reeval: '0.1.0', runId: 'run-1', startedAt: '', harness: 'cursor', verbosity },
      warn: (message) => assert.fail(message),
      heartbeatMs: 0,
    })
    for (const e of events) stream.write(e)
    await stream.end(1)
    if (beats) {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
      const beat = JSON.stringify({ type: 'heartbeat', at: 1 })
      const exit = lines.pop()
      writeFileSync(file, `${[...lines.flatMap((l) => [l, beat]), exit].join('\n')}\n`)
    }
    let text = ''
    const code = await attach({
      source: file,
      out: { write: (chunk: string) => (text += chunk) },
      output: () => output,
    })
    return { code, text }
  }

  const streams: Record<string, ReevalEvent[]> = {
    interleaved,
    'a two-line failure': withLongMessage,
    'sandboxes prepared, then a plan': [...prepared, planEvent()],
  }
  // The heartbeat runs on the wall clock in both, so it's off for the comparison.
  const outputs: Record<string, OutputOptions> = {
    grouped: options({ heartbeatMs: 0 }),
    stream: options({ heartbeatMs: 0, logOrder: 'stream' }),
    'errors-only': options({ heartbeatMs: 0, outputLogs: 'errors-only' }),
    'GitHub Actions': options({ heartbeatMs: 0, githubActions: true, logPrefix: 'none' }),
    agent: options({ heartbeatMs: 0, mode: 'agent' }),
  }
  for (const [name, events] of Object.entries(streams)) {
    for (const [mode, output] of Object.entries(outputs)) {
      test(`draws the recorded stream as the run did: ${name}, ${mode}`, async () => {
        const { code, text } = await attached(events, output)
        assert.equal(code, 1, "the run's exit code")
        assert.equal(text, direct(events, output))
        assert.ok(text.length > 0)
        assert.equal(
          (await attached(events, output, 0, true)).text,
          text,
          'heartbeats draw nothing',
        )
      })
    }
  }

  test('draws -v detail lines as the run did', async () => {
    const output = options({ heartbeatMs: 0, logOrder: 'stream' })
    assert.equal(
      (await attached(withLongMessage, output, 1)).text,
      direct(withLongMessage, output, 1),
    )
  })

  /** A terminal on both stdin and stdout, as Ink reads keys from and draws on it. */
  const terminal = () => {
    let drawn = ''
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 100,
      rows: 40,
      write: (chunk: string, done?: () => void) => {
        drawn += chunk
        done?.()
        return true
      },
    })
    let data: string | null = null
    const raw: boolean[] = []
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setEncoding() {},
      setRawMode(on: boolean) {
        raw.push(on)
      },
      resume() {},
      pause() {},
      ref() {},
      unref() {},
      read() {
        const chunk = data
        data = null
        return chunk
      },
    })
    /** What the terminal shows has `text`, drawn since `from`. */
    const shows = (text: string, from = 0) => stripAnsi(drawn.slice(from)).includes(text)
    return {
      tty: { stdout: stdout as never, stdin: stdin as never },
      raw,
      reading: () => stdin.listenerCount('readable') > 0,
      shows,
      /** Presses `key` once the list reads keys, and waits until it has drawn `then`. */
      press: async (key: string, then?: string) => {
        await until(() => stdin.listenerCount('readable') > 0)
        const from = drawn.length
        data = key
        stdin.emit('readable')
        if (then) await until(() => shows(then, from))
      },
    }
  }
  /** Until `ready()`, checked every few milliseconds, for at most 10s. */
  const until = async (ready: () => boolean) => {
    for (const deadline = Date.now() + 10_000; !ready(); await sleep(5)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${ready}`)
    }
  }
  const listed = options({
    statusLine: true,
    interactive: true,
    outputLogs: 'none',
    heartbeatMs: 0,
  })
  const streamOf = (file: string, append = false) =>
    openEventStream({
      file,
      append,
      header: { reeval: '0.1.0', runId: 'run-1', startedAt: '', harness: 'cursor', verbosity: 0 },
      warn: (message) => assert.fail(message),
    })
  /** A project whose run-1 is this process, as its live.json says, with its stream in events/. */
  const liveProject = (over: { phase?: 'cancelling' | 'finishing'; ago?: number } = {}) => {
    const root = tempDir('ui-attach')
    const live = writeLiveProgress({
      dir: join(root, '.reeval', 'staging', 'run-1'),
      runId: 'run-1',
      startedAt: new Date(),
      planned: [],
      now: () => new Date(Date.now() - (over.ago ?? 0)),
    })
    live.stop()
    if (over.phase) live.phase(over.phase)
    return { root, file: join(root, '.reeval', 'events', 'run-1.ndjson') }
  }
  /** What `reeval run` leaves in the scrollback once its list is quit. */
  const quitList = async (events: ReevalEvent[]) => {
    let text = ''
    const renderer = new InteractiveRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      stdout: {} as never,
      stdin: {} as never,
      colors: colors(false),
      output: listed,
      harness: 'cursor',
      load: async () => ({
        mountList: () => ({ waitUntilExit: async () => {}, unmount: () => {} }),
      }),
    })
    for (const e of events) renderer.onEvent(e)
    renderer.close()
    await renderer.wait()
    return text
  }

  test('on a terminal, draws the list and keeps it up until q, then leaves what reeval run does', async () => {
    const file = join(tempDir('ui-events'), 'events.ndjson')
    const stream = streamOf(file)
    for (const e of interleaved) stream.write(e)
    await stream.end(1)
    const { tty, shows, press } = terminal()
    let text = ''
    let done = false
    const run = attach({
      source: file,
      out: { write: (chunk: string) => (text += chunk) },
      output: () => listed,
      tty,
    }).finally(() => {
      done = true
    })
    await until(() => shows('q quit'))
    assert.equal(done, false, 'the list stays up once the stream has ended')
    await press('q')
    assert.equal(await run, 1, "the run's exit code")
    assert.equal(text, await quitList(interleaved))
  })

  test('on a terminal, a run that stopped beating shows above the list as stalled', async () => {
    const file = join(tempDir('ui-events'), 'events.ndjson')
    const stream = streamOf(file)
    for (const e of interleaved.slice(0, 5)) stream.write(e)
    await stream.end(1)
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').slice(0, -1)
    writeFileSync(file, `${[...lines, JSON.stringify({ type: 'heartbeat', at: 1 })].join('\n')}\n`)
    const { tty, shows, press } = terminal()
    let text = ''
    const run = attach({
      source: file,
      out: { write: (chunk: string) => (text += chunk) },
      output: () => listed,
      tty,
      follow: { pollMs: 10 },
      silence: { stallMs: 50, lostMs: 60_000 },
    })
    await until(() => shows('No word from run run-1 for 50ms'))
    assert.ok(shows('q detach'), 'the list stays up')
    await press('q')
    assert.equal(await run, 0)
    assert.match(text, /Detached from run run-1/)
  })

  test('on a terminal, q detaches from a run in progress and x twice cancels it by its pid', async () => {
    const { root, file } = liveProject()
    const stream = streamOf(file)
    for (const e of interleaved.slice(0, 5)) stream.write(e)
    const { tty, shows, press } = terminal()
    let text = ''
    const signaled: number[] = []
    try {
      const run = attach({
        source: file,
        root,
        out: { write: (chunk: string) => (text += chunk) },
        output: () => listed,
        tty,
        follow: { pollMs: 10 },
        signalRun: (pid) => signaled.push(pid),
      })
      await until(() => shows('q detach · x cancel the run'))
      await press('x', 'Press x again to cancel the run.')
      assert.deepEqual(signaled, [], 'one x only asks')
      await press('x', 'q detach')
      assert.deepEqual(signaled, [process.pid], "the run's own process, from the header")
      await press('q')
      assert.equal(await run, 0, 'detaching exits 0')
      assert.deepEqual(signaled, [process.pid], 'q never signals the run')
      assert.ok(text.endsWith('Detached from run run-1; it goes on.\n'), text)
    } finally {
      await stream.end(0)
    }
  })

  test("on a terminal, x is offered only when the run's live.json vouches for the stream's pid", async () => {
    const cases: Record<string, (root: string) => void> = {
      'no live.json': (root) => rmSync(join(root, '.reeval', 'staging'), { recursive: true }),
      'another process (a reused pid)': (root) => {
        const path = join(root, '.reeval', 'staging', 'run-1', 'live.json')
        const live = JSON.parse(readFileSync(path, 'utf8'))
        writeFileSync(path, JSON.stringify({ ...live, pid: process.pid + 1 }))
      },
      canceling: (root) => {
        writeLiveProgress({
          dir: join(root, '.reeval', 'staging', 'run-1'),
          runId: 'run-1',
          startedAt: new Date(),
          planned: [],
        }).phase('cancelling')
      },
      'a stale heartbeat': (root) => {
        writeLiveProgress({
          dir: join(root, '.reeval', 'staging', 'run-1'),
          runId: 'run-1',
          startedAt: new Date(),
          planned: [],
          now: () => new Date(Date.now() - 60_000),
        }).stop()
      },
    }
    for (const [name, spoil] of Object.entries(cases)) {
      const { root, file } = liveProject()
      spoil(root)
      const stream = streamOf(file)
      for (const e of interleaved.slice(0, 5)) stream.write(e)
      const { tty, shows, press } = terminal()
      let text = ''
      const signaled: number[] = []
      try {
        const run = attach({
          source: file,
          root,
          out: { write: (chunk: string) => (text += chunk) },
          output: () => listed,
          tty,
          follow: { pollMs: 10 },
          signalRun: (pid) => signaled.push(pid),
        })
        await until(() => shows('q detach'))
        assert.ok(!shows('x cancel'), name)
        await press('x')
        await press('x')
        await press('q')
        assert.equal(await run, 0, name)
        assert.deepEqual(signaled, [], name)
        assert.ok(!shows('Press x again'), name)
        if (name !== 'canceling') {
          assert.ok(text.endsWith('Detached from run run-1.\n'), `${name}: ${text}`)
        }
      } finally {
        await stream.end(0)
      }
    }
  })

  test('on a terminal, x checks again at the press: an owner Ctrl-C or a dead pid since sends nothing', async () => {
    for (const since of ['canceled', 'died'] as const) {
      const { root, file } = liveProject()
      const stream = streamOf(file)
      for (const e of interleaved.slice(0, 5)) stream.write(e)
      const { tty, shows, press } = terminal()
      let text = ''
      let alive = true
      const signaled: number[] = []
      try {
        const run = attach({
          source: file,
          root,
          out: { write: (chunk: string) => (text += chunk) },
          output: () => listed,
          tty,
          // Asleep while the pid dies, so the follow doesn't end the stream before the press.
          follow: { pollMs: 60_000, alive: () => alive },
          signalRun: (pid) => signaled.push(pid),
        })
        await until(() => shows('x cancel the run'))
        await press('x', 'Press x again')
        if (since === 'canceled') {
          writeLiveProgress({
            dir: join(root, '.reeval', 'staging', 'run-1'),
            runId: 'run-1',
            startedAt: new Date(),
            planned: [],
          }).phase('cancelling')
        } else alive = false
        await press('x', "The run can't be canceled from here now.")
        assert.deepEqual(signaled, [], since)
        await press('q')
        assert.equal(await run, 0, since)
        assert.ok(text.endsWith('Detached from run run-1.\n'), `${since}: ${text}`)
      } finally {
        await stream.end(0)
      }
    }
  })

  test("on a terminal, a stream cut off as its run's process dies takes the list down and fails", async () => {
    const { root, file } = liveProject()
    const stream = streamOf(file)
    for (const e of interleaved.slice(0, 5)) stream.write(e)
    const { tty, raw, reading, shows } = terminal()
    let alive = true
    try {
      const run = attach({
        source: file,
        root,
        out: { write: () => true },
        output: () => listed,
        tty,
        follow: { pollMs: 10, alive: () => alive },
      })
      await until(() => shows('q detach'))
      alive = false
      await assert.rejects(run, EventStreamError)
      assert.equal(raw.at(-1), false, 'the terminal is back out of raw mode')
      assert.equal(reading(), false, 'nothing reads keys any more')
    } finally {
      await stream.end(0)
    }
  })

  test('on a terminal, a run on another host offers no cancel and names that host on its paths', async () => {
    const remote = (file: string) => {
      const [head = '', ...rest] = readFileSync(file, 'utf8').split('\n')
      writeFileSync(
        file,
        [JSON.stringify({ ...JSON.parse(head), host: 'build-7' }), ...rest].join('\n'),
      )
    }
    const going = liveProject()
    const stream = streamOf(going.file)
    for (const e of interleaved.slice(0, 5)) stream.write(e)
    remote(going.file)
    const signaled: number[] = []
    let text = ''
    try {
      const { tty, shows, press } = terminal()
      const run = attach({
        source: going.file,
        root: going.root,
        out: { write: (chunk: string) => (text += chunk) },
        output: () => listed,
        tty,
        follow: { pollMs: 10 },
        signalRun: (pid) => signaled.push(pid),
      })
      await until(() => shows('q detach'))
      assert.ok(!shows('x cancel'))
      await press('x')
      await press('x')
      await press('q')
      assert.equal(await run, 0)
      assert.deepEqual(signaled, [], 'nothing reaches a run on another host')
      assert.ok(text.endsWith('Detached from run run-1.\n'), 'whether it goes on is unknown here')
    } finally {
      await stream.end(0)
    }

    const ended = join(tempDir('ui-events'), 'events.ndjson')
    const done = streamOf(ended)
    for (const e of interleaved) done.write(e)
    await done.end(1)
    remote(ended)
    const { tty, shows, press } = terminal()
    text = ''
    const run = attach({
      source: ended,
      out: { write: (chunk: string) => (text += chunk) },
      output: () => listed,
      tty,
    })
    await until(() => shows('q quit'))
    await press('q')
    assert.equal(await run, 1)
    assert.match(
      text,
      /^Browse it: reeval studio · summary \.reeval\/runs\/run-1\/summary\.md \(on build-7\)$/m,
    )
    assert.notEqual(hostname(), 'build-7')
  })

  test('on a terminal, a resumed run prints the first list as it ended, then browses the resume', async () => {
    const file = join(tempDir('ui-events'), 'events.ndjson')
    const first = streamOf(file)
    for (const e of interleaved) first.write(e)
    await first.end(1)
    const resume = streamOf(file, true)
    for (const e of interleaved) resume.write(e)
    await resume.end(0)
    const { tty, shows, press } = terminal()
    let text = ''
    const run = attach({
      source: file,
      out: { write: (chunk: string) => (text += chunk) },
      output: () => listed,
      tty,
    })
    const once = await quitList(interleaved)
    await until(() => text === once)
    await until(() => shows('q quit'))
    await press('q')
    assert.equal(await run, 0, "the resume's exit code")
    assert.equal(text, once + once)
  })
})
