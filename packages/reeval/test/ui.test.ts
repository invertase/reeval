import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { EvalEntry, JudgementRecord, RunRecord } from '../src/history/types.ts'
import type { AttemptMeta, CompareAnswer, TokenUsage } from '../src/types.ts'
import { AgentRenderer } from '../src/ui/agent.ts'
import { colors } from '../src/ui/colors.ts'
import type { EvalResult, Progress, ReevalEvent } from '../src/ui/events.ts'
import { type OutputOptions, resolveOutput } from '../src/ui/mode.ts'
import { PlainRenderer } from '../src/ui/plain.ts'
import { renderSummary } from '../src/ui/summary.ts'
import { Tagger } from '../src/ui/tags.ts'
import { pkgRoot } from './helpers.ts'

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

const entry = (r: EvalResult, turns: number, judge?: number): EvalEntry =>
  ({
    id: r.id,
    slug: 'slug',
    file: r.file,
    group: r.group,
    name: r.name,
    outcome: r.meta?.outcome ?? 'pass',
    cells: [],
    attempts: [
      {
        id: `${CELL}#1`,
        cell: CELL,
        n: 1,
        outcome: r.meta?.outcome ?? 'pass',
        error: r.meta?.errorKind ? { kind: r.meta.errorKind, message: r.errors[0] ?? '' } : null,
        durationMs: r.durationMs,
        turns: Array.from({ length: turns }, () => ({})),
        judgements:
          judge === undefined
            ? []
            : [{ verdict: 'pass', score: judge, threshold: 0.8, question: 'q', key: '0:q' }],
      },
    ],
  }) as unknown as EvalEntry

const record = {
  durationMs: 365_000,
  cost: { usage: null },
  summary: { evals: 2, attempts: 2, pass: 1, fail: 1, notGated: 0, infraError: 0, skipped: 0 },
  evals: [entry(greetResult, 1, 0.92), entry(defaultResult, 2)],
} as unknown as RunRecord

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
    unhandledErrors: [],
  },
]

const options = (overrides: Partial<OutputOptions> = {}): OutputOptions => ({
  requested: 'plain',
  mode: 'plain',
  logOrder: 'grouped',
  logPrefix: 'task',
  outputLogs: 'full',
  color: false,
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
    attemptDir: (id, _cell, n) =>
      `.reeval/runs/run-1/${id.split(' › ').at(-1)?.split(' ')[0]}/${n}`,
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

const SUMMARY = [
  '',
  'Summary',
  ' evals/hello.eval.ts',
  '   greet module',
  '     ✓ creates a tested greet module             3m 12s  pass 0.92/0.80  1 turn',
  '     ✗ adds a default name in a follow-up turn   6m 03s  2 turns',
  '',
  'Failures (1)',
  '',
  'Assertion failures (1)',
  ' ✗ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
  '   AssertionError: expected 1 to be 2 // Object.is equality',
  '',
  '   - Expected',
  '   + Received',
  '',
  '   - 2',
  '   + 1',
  '',
  '    ❯ evals/hello.eval.ts:31:20',
  '   record  .reeval/runs/run-1/adds/1',
  '',
  '   Evals  1 passed · 1 failed (2)',
  'Duration  6m 05s',
  ' Results  .reeval/runs/run-1/summary.md',
]

describe('plain renderer', () => {
  test('grouped: start lines stream, each attempt prints as one block when it ends', () => {
    assert.equal(
      render(interleaved, options()),
      lines(
        'reeval 0.1.0 · run 20260101T000000Z_nogit_test_abcd · 1 eval file · harness cursor/composer-2.5 · sandbox docker · concurrency 2 · grouped logs',
        '[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module',
        '[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn',
        '… 2 running after 1m 01s: [creates#1 cursor] turn 1 1m 01s, [adds#1 cursor] turn 1 1m 00s',
        '… 2 running after 2m 01s: [creates#1 cursor] turn 1 2m 01s, [adds#1 cursor] turn 1 2m 00s',
        '… 2 running after 3m 01s: [creates#1 cursor] cleanup 3m 01s, [adds#1 cursor] turn 1 3m 00s',
        '[creates#1 cursor] ✓ evals/hello.eval.ts › greet module › creates a tested greet module  3m 12s',
        '[creates#1 cursor]  +0:01 sandbox ready 4s',
        '[creates#1 cursor]  +0:05 turn 1 done 2m 45s · 6 tool calls, 2 file edits',
        '[creates#1 cursor]  +2:50 $ node --test  exit 0 1s',
        '[creates#1 cursor]  +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '… 1 running after 4m 12s: [adds#1 cursor] turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] turn 2 5m 11s',
        '[adds#1 cursor] ✗ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn  6m 03s',
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
        ...SUMMARY,
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
    const block = out.slice(out.indexOf('::group::'), out.indexOf('\nSummary'))
    assert.equal(
      block,
      lines(
        '::group::[creates#1 cursor] ✓ evals/hello.eval.ts › greet module › creates a tested greet module  3m 12s',
        ' +0:01 sandbox ready 4s',
        ' +0:05 turn 1 done 2m 45s · 6 tool calls, 2 file edits',
        ' +2:50 $ node --test  exit 0 1s',
        ' +2:52 judge  pass 0.92 (≥ 0.8)  Accurate summary?',
        '::endgroup::',
        '… 1 running after 4m 12s: [adds#1 cursor] turn 2 4m 11s',
        '… 1 running after 5m 12s: [adds#1 cursor] turn 2 5m 11s',
        '[adds#1 cursor] ✗ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn  6m 03s',
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

  test('errors-only prints detail for failing attempts only', () => {
    const out = render(interleaved, options({ outputLogs: 'errors-only', logOrder: 'stream' }))
    assert.doesNotMatch(out, /\[creates#1 cursor\] {2}\+/)
    assert.match(out, /\[adds#1 cursor\] {2}\+1:09 stdout \| seeding greet\.js/)
  })

  test('colour: prefixes get Turborepo palette colours, group titles stay plain', () => {
    const out = render(interleaved, options({ githubActions: true }), true)
    assert.ok(out.includes('\x1b[36m[creates#1 cursor]\x1b[39m'))
    assert.ok(out.includes('\x1b[35m[adds#1 cursor]\x1b[39m'))
    assert.match(out, /^::group::\[creates#1 cursor\] ✓ /m)
  })

  test('the heartbeat stays quiet while other lines are printing, and when it is off', () => {
    const out = render(interleaved, options({ heartbeatMs: 0 }))
    assert.doesNotMatch(out, /running after/)
  })
})

/** The same run with the first eval's compare questions answered, one of them failed. */
const answered: ReevalEvent[] = interleaved.map((e) => {
  if (e.type !== 'run-end') return e
  const [first, ...rest] = e.record.evals
  const answers: CompareAnswer[] = [
    {
      question: 'Which is cleaner?',
      model: 'google/gemini-3.8-flash',
      votes: [
        {
          question: 'Which is cleaner?',
          cut: 'across',
          arm: '-',
          run: 1,
          a: 'cursor',
          b: 'codex',
          winner: 'codex',
          swapped: false,
        },
        {
          question: 'Which is cleaner?',
          cut: 'across',
          arm: '-',
          run: 1,
          a: 'cursor',
          b: 'codex',
          winner: 'tie',
          swapped: true,
        },
      ],
      rates: [
        { cut: 'across', name: 'cursor', wins: 0, n: 1 },
        { cut: 'across', name: 'codex', wins: 1, n: 1 },
      ],
    },
    {
      question: 'Which is shorter?',
      model: 'google/gemini-3.8-flash',
      votes: [],
      rates: [],
      error: 'quota exceeded',
    },
  ]
  return { ...e, record: { ...e.record, evals: [{ ...first, answers } as EvalEntry, ...rest] } }
})

const ANSWER_LINES = [
  '"Which is cleaner?" across: cursor 0/1 (0%), codex 1/1 (100%) · 2 votes, 1 tie, 0/1 pairs split by order · google/gemini-3.8-flash',
  '"Which is shorter?" 0 votes, 0 ties · google/gemini-3.8-flash · failed: quota exceeded',
]

describe('compare answers in the summary', () => {
  test('plain: one line per question under its eval', () => {
    const out = render(answered, options())
    assert.ok(
      out.includes(
        lines(
          '     ✓ creates a tested greet module             3m 12s  pass 0.92/0.80  1 turn',
          ...ANSWER_LINES.map((l) => `         question  ${l}`),
          '     ✗ adds a default name in a follow-up turn   6m 03s  2 turns',
        ),
      ),
      out,
    )
  })

  test('agent: one line per question before the totals', () => {
    let text = ''
    const renderer = new AgentRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      attemptDir: () => '.reeval/runs/run-1/adds/1',
    })
    for (const e of answered) renderer.onEvent(e)
    assert.ok(
      text.endsWith(
        lines(
          ...ANSWER_LINES.map((l) => `question ${GREET}: ${l}`),
          '1 passed, 1 failed',
          'summary: .reeval/runs/run-1/summary.md',
        ),
      ),
      text,
    )
  })
})

const judgement = (
  question: string,
  verdict: 'pass' | 'fail',
  score: number,
  key: string,
  threshold = 0.8,
): JudgementRecord => ({ question, verdict, score, threshold, model: 'fake', key })

const usage = (input: number, output: number): TokenUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
})

function summaryOf(evals: EvalEntry[]): string {
  const attempts = evals.reduce((n, e) => n + e.attempts.length, 0)
  return renderSummary(
    colors(false),
    {
      type: 'run-end',
      at: T0,
      record: {
        durationMs: 1000,
        cost: { usage: null },
        summary: {
          evals: evals.length,
          attempts,
          pass: 0,
          fail: 0,
          notGated: 0,
          infraError: 0,
          skipped: 0,
        },
        evals,
      } as unknown as RunRecord,
      summaryPath: '.reeval/runs/run-1/summary.md',
      results: [],
      unhandledErrors: [],
    },
    () => '.reeval/runs/run-1/x/1',
  ).join('\n')
}

function withAttempt(base: EvalEntry, patch: Partial<EvalEntry['attempts'][number]>): EvalEntry {
  const [first, ...rest] = base.attempts
  assert.ok(first)
  return { ...base, attempts: [{ ...first, ...patch }, ...rest] }
}

describe('collapsed judges, per-key rates and tokens', () => {
  test('a collapsed attempt line shows verdict and score/threshold, and usage when reported', () => {
    const e = withAttempt(entry(greetResult, 1, 0.92), {
      usage: usage(1270, 80),
      judgements: [judgement('Accurate summary?', 'pass', 0.92, '0:acc')],
    })
    const out = summaryOf([e])
    assert.match(out, /pass 0\.92\/0\.80/)
    assert.match(out, /1,270 in · 80 out/)
    assert.doesNotMatch(out, /judge 0\.92[^/]/)
  })

  test('two judges print as fail 0.78/0.80 · pass 0.99/0.80; many collapse to the min plus a count', () => {
    const two = withAttempt(entry(greetResult, 1), {
      judgements: [
        judgement('login', 'fail', 0.78, '0:login'),
        judgement('checkout', 'pass', 0.99, '1:checkout'),
      ],
    })
    assert.match(summaryOf([two]), /fail 0\.78\/0\.80 · pass 0\.99\/0\.80/)

    const many = withAttempt(entry(greetResult, 1), {
      judgements: [
        judgement('a', 'fail', 0.5, '0:a'),
        judgement('b', 'fail', 0.33, '1:b'),
        judgement('c', 'pass', 0.9, '2:c'),
      ],
    })
    const out = summaryOf([many])
    assert.match(out, /fail 0\.33\/0\.80 · 3 judges/)
    assert.doesNotMatch(out, /0\.50/)
  })

  test('an eval its gate passes shows ! with an infra error or no counted attempt, never ✓', () => {
    const base = entry(greetResult, 1)
    const [first] = base.attempts
    assert.ok(first)
    const ungated = (outcomes: Array<'pass' | 'fail' | 'infra_error'>): EvalEntry => {
      const count = (o: string) => outcomes.filter((x) => x === o).length
      const cell = {
        key: CELL,
        harness: 'fake',
        environment: 'default',
        sandbox: 'fake',
        role: 'control',
        gate: 'none',
        overrides: [],
        runs: outcomes.length,
        pass: count('pass'),
        fail: count('fail'),
        infraError: count('infra_error'),
        skipped: 0,
        passRate: null,
        outcome: 'pass',
      } as unknown as EvalEntry['cells'][number]
      return {
        ...base,
        outcome: 'pass',
        cells: [cell],
        attempts: outcomes.map((outcome, i) => ({
          ...first,
          id: `${CELL}#${i + 1}`,
          n: i + 1,
          outcome,
        })),
      }
    }
    const markOf = (e: EvalEntry) =>
      summaryOf([e])
        .split('\n')
        .find((l) => l.includes(` ${e.name} `))
        ?.trim()
        .slice(0, 1)
    assert.equal(markOf(ungated(['infra_error', 'infra_error', 'infra_error'])), '!', '0/0')
    assert.equal(markOf(ungated(['fail', 'infra_error'])), '!', 'a miss and an infra error')
    assert.equal(markOf(ungated(['pass', 'pass'])), '✓')
  })

  test('null usage is omitted, never printed as zero', () => {
    const e = withAttempt(entry(greetResult, 1, 0.92), { usage: null })
    const out = summaryOf([e])
    assert.doesNotMatch(out, /0 in/)
    assert.doesNotMatch(out, /0 out/)
  })

  test('cell rows show per-key rates, lift only when both sides have enough counted, and a usage sum', () => {
    const cell = (
      key: string,
      role: 'control' | 'variant',
      env: string,
    ): EvalEntry['cells'][number] =>
      ({
        key,
        harness: 'fake',
        environment: env,
        sandbox: 'fake',
        role,
        gate: role === 'control' ? 'none' : 'all',
        overrides: [],
        runs: 2,
        pass: role === 'variant' ? 2 : 0,
        fail: role === 'variant' ? 0 : 2,
        infraError: 0,
        skipped: 0,
        passRate: role === 'variant' ? 1 : 0,
        outcome: role === 'variant' ? 'pass' : 'fail',
      }) as EvalEntry['cells'][number]

    const attemptOf = (
      cellKey: string,
      n: number,
      outcome: 'pass' | 'fail',
      login: 'pass' | 'fail',
      checkout: 'pass' | 'fail',
      tokens: TokenUsage | null,
    ) =>
      ({
        id: `${cellKey}#${n}`,
        cell: cellKey,
        n,
        outcome,
        usage: tokens,
        turns: [{}],
        judgements: [
          judgement('login', login, login === 'pass' ? 0.95 : 0.2, '0:login'),
          judgement('checkout', checkout, checkout === 'pass' ? 0.91 : 0.1, '1:checkout'),
        ],
      }) as unknown as EvalEntry['attempts'][number]

    const multi: EvalEntry = {
      ...entry(greetResult, 1),
      cells: [
        cell('fake/plain/fake', 'control', 'plain'),
        cell('fake/skill/fake', 'variant', 'skill'),
      ],
      attempts: [
        attemptOf('fake/plain/fake', 1, 'fail', 'fail', 'fail', usage(100, 10)),
        attemptOf('fake/plain/fake', 2, 'fail', 'pass', 'fail', usage(100, 10)),
        attemptOf('fake/skill/fake', 1, 'pass', 'pass', 'fail', usage(80, 8)),
        attemptOf('fake/skill/fake', 2, 'pass', 'pass', 'fail', usage(80, 8)),
      ],
    }
    const out = summaryOf([multi])
    assert.match(out, /login 1\/2/)
    assert.match(out, /checkout 0\/2/)
    assert.match(out, /login 2\/2 \(\+50 pts\)/)
    assert.match(out, /200 in · 20 out/)
    assert.match(out, /160 in · 16 out/)

    const thin: EvalEntry = {
      ...multi,
      cells: multi.cells.map((c) => ({
        ...c,
        runs: 1,
        pass: c.role === 'variant' ? 1 : 0,
        fail: c.role === 'variant' ? 0 : 1,
      })),
      attempts: multi.attempts.filter((a) => a.n === 1),
    }
    const thinOut = summaryOf([thin])
    assert.match(thinOut, /login 1\/1/)
    assert.doesNotMatch(thinOut, /\(\+\d+ pts\)/)
  })

  test('cell rows distinguish judges that share a clipped prefix', () => {
    const email = 'Does this change implement email sign-in?'
    const social = 'Does this change implement social sign-in?'
    const colliding: EvalEntry = {
      ...entry(greetResult, 1),
      cells: [
        {
          key: 'fake/plain/fake',
          harness: 'fake',
          environment: 'plain',
          sandbox: 'fake',
          role: 'control',
          gate: 'all',
          overrides: [],
          runs: 2,
          pass: 0,
          fail: 2,
          infraError: 0,
          skipped: 0,
          passRate: 0,
          outcome: 'fail',
        } as EvalEntry['cells'][number],
      ],
      attempts: [1, 2].map((n) => ({
        id: `fake/plain/fake#${n}`,
        cell: 'fake/plain/fake',
        n,
        outcome: 'fail',
        usage: null,
        turns: [{}],
        judgements: [
          judgement(email, n === 1 ? 'pass' : 'fail', n === 1 ? 0.9 : 0.2, '0:email'),
          judgement(social, 'fail', 0.1, '1:social'),
        ],
      })) as EvalEntry['attempts'],
    }
    const out = summaryOf([colliding])
    assert.match(out, /…email sign-in 1\/2/)
    assert.match(out, /…social sign-in 0\/2/)
    assert.doesNotMatch(out, /Does this change…/)
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
    attemptDir: () => '.reeval/runs/run-1/greet/1',
  })
  for (const e of events) renderer.onEvent(e)
  assert.match(
    agent,
    /downloading chrome-headless-shell 140\.0\.7339\.185 128\.0 MB \/ 274\.0 MB → ~\/\.cache\/reeval/,
  )
})

describe('agent renderer', () => {
  test('prints failures only, each with its record path, and ends with the summary path', () => {
    let text = ''
    const renderer = new AgentRenderer({
      out: { write: (chunk: string) => (text += chunk) },
      attemptDir: () => '.reeval/runs/run-1/adds/1',
    })
    for (const e of interleaved) renderer.onEvent(e)
    assert.equal(
      text,
      lines(
        'reeval run: 20260101T000000Z_nogit_test_abcd · 1 eval file',
        'FAIL evals/hello.eval.ts › greet module › adds a default name in a follow-up turn (6m 03s, assertion)',
        '  AssertionError: expected 1 to be 2 // Object.is equality',
        '',
        '  - Expected',
        '  + Received',
        '',
        '  - 2',
        '  + 1',
        '',
        '   ❯ evals/hello.eval.ts:31:20',
        '  console:',
        '    seeding greet.js',
        '  record: .reeval/runs/run-1/adds/1',
        '1 passed, 1 failed',
        'summary: .reeval/runs/run-1/summary.md',
      ),
    )
    assert.ok(!text.includes('\x1b['))
  })
})

describe('output mode', () => {
  const resolve = (env: NodeJS.ProcessEnv, isTTY = true, agent?: string, flags = {}) =>
    resolveOutput({ flags, env, isTTY, agent })

  test('auto: agent, then plain in CI or when piped, then live (printed as plain for now)', () => {
    assert.equal(resolve({}, true, 'cursor').mode, 'agent')
    assert.equal(resolve({ CI: '1' }).requested, 'plain')
    assert.equal(resolve({}, false).requested, 'plain')
    assert.deepEqual([resolve({}).requested, resolve({}).mode], ['live', 'plain'])
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

  test('GitHub Actions: grouped, no detail prefix, colour on', () => {
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

  test('colour: NO_COLOR, then FORCE_COLOR, never for agents, else when a TTY', () => {
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
