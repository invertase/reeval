import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { EvalEntry, RunRecord } from '../src/history/types.ts'
import type { AttemptMeta } from '../src/types.ts'
import { AgentRenderer } from '../src/ui/agent.ts'
import { colors } from '../src/ui/colors.ts'
import type { EsEvent, EvalResult, Progress } from '../src/ui/events.ts'
import { type OutputOptions, resolveOutput } from '../src/ui/mode.ts'
import { PlainRenderer } from '../src/ui/plain.ts'
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

const progress = (id: string, at: number, p: Omit<Progress, 'at'>): EsEvent =>
  ({ type: 'eval-progress', key: keyOf(id), progress: { at, ...p } }) as EsEvent

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
const interleaved: EsEvent[] = [
  {
    type: 'run-start',
    at: T0,
    version: '0.1.0',
    files: 1,
    harness: 'cursor/composer-2.5',
    sandbox: 'docker',
    concurrency: 2,
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
function render(events: EsEvent[], output: OutputOptions, color = false): string {
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
  '     ✓ creates a tested greet module             3m 12s  judge 0.92  1 turn',
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
        'reeval 0.1.0 · 1 eval file · harness cursor/composer-2.5 · sandbox docker · concurrency 2 · grouped logs',
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
        'reeval run: 1 eval file',
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
    assert.throws(() => resolve({}, true, undefined, { ui: 'fancy' }), /--ui must be one of/)
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
