import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import fsp, { cp, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, mock, test } from 'node:test'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { handshakeTimeoutLines } from '../src/studio/command.ts'
import { startStudio } from '../src/studio/index.ts'
import { createStudioApi } from '../src/studio/server.ts'
import { listHeaders, type StudioSource } from '../src/studio/source.ts'
import {
  type AttemptTrace,
  type AttemptView,
  activityLabel,
  answerRows,
  attemptAnswerRows,
  attemptFacts,
  buildAttemptView,
  buildRunView,
  cellEffort,
  cellJudgeRates,
  cellRows,
  cellUsage,
  collapsedJudgeLabel,
  compareView,
  evalHistory,
  evalTree,
  failedJudgeLabels,
  judgeLabel,
  type PairResponse,
  pageLimit,
  parseStudioPath,
  parseTranscript,
  RUN_LIST_LIMIT,
  type RunList,
  type RunView,
  runHeader,
  runLead,
  runOutcome,
  runRows,
  STUDIO_API_PREFIX,
  STUDIO_API_VERSION,
  STUDIO_ROUTES,
  splitPatch,
  studioPaths,
  TRANSCRIPT_LIMIT,
  transcriptItems,
  uniqueJudgeLabels,
  VIEW_VERSION,
} from '../src/view/index.ts'
import { baseEnv, fakeConfig, pkgRoot, project, runCli } from './helpers.ts'
import { e2eNewlineAnswer, realAttempts } from './support/real-runs.ts'

const RUN = '20260924T220414Z_f7e1b53_elliot-hesp_k3f9'

// A real history: three recorded runs of the fake agent (pass, fail, a control and a variant ×
// two runs, with a compare question) and one scratch run.
const evalFile = `import { defineEnvironment, evaluate, expect, group } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const other = defineEnvironment('other', { sandbox })
group('greet', process.env.REEVAL_TEST_COMPARE ? { compare: { control: plain, variants: [other] }, questions: [{ question: 'Which wrote hello.txt?', across: 'environment', task: true, diff: true }], runs: 2 } : {}, () => {
  evaluate('writes hello', async (c) => {
    await c.send('write hello.txt')
    await expect(c.exec('test -f hello.txt')).toSucceed()
    expect(await c.judge('Did it write hello.txt?', { diff: true })).toPass()
  })
})
`
const agent =
  "{ files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it', tools: [{ tool: 'read', input: { path: 'README.md' }, output: '' }] }"

let dir = ''
let source: StudioSource
let headers: HistoryEntry[]
const records = new Map<string, RunRecord>()

before(async () => {
  const p = await project('studio', {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    // The question's model picks whichever attempt it's shown first. Passing attempts keep their
    // files, which the studio serves.
    'reeval.config.ts': fakeConfig({
      harness: agent,
      extra:
        "analysis: { model: { kind: 'fake-analysis', vote: 'A' } }, history: { artifacts: 'all' },",
    }),
    'evals/hello.eval.ts': evalFile,
    'reeval.fail.config.ts': fakeConfig({
      harness: agent,
      judge: '{ model: fakeJudge({ score: 0.2 }) }',
      extra: "history: { artifacts: 'all' },",
    }),
  })
  dir = p.dir
  for (const [args, env] of [
    [['run', '--record']],
    [['run', '--record', '--config', 'reeval.fail.config.ts']],
    [['run', '--record'], { REEVAL_TEST_COMPARE: '1' }],
    [['run']],
  ] as Array<[string[], NodeJS.ProcessEnv?]>) {
    const r = await runCli(dir, args, { env })
    assert.ok(r.code === 0 || r.code === 1, r.stderr + r.stdout)
  }
  source = { root: dir, historyDir: join(dir, 'evals/.history'), scratch: true }
  headers = await listHeaders(source)
  for (const h of headers) {
    const folder = h.recorded ? source.historyDir : join(dir, '.reeval/runs')
    records.set(h.runId, JSON.parse(readFileSync(join(folder, `${h.runId}.json`), 'utf8')))
  }
})

describe('run outcome and activity, as the CLI has them', () => {
  const skilled = `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.inline({ name: 'ok', description: 'Writes ok.txt', content: 'Write ok.txt.' })],
}))
const compare = process.env.REEVAL_TEST_GATE_ALL
  ? { control: plain, variants: [skilled], gate: 'all' as const }
  : { control: plain, variants: [skilled] }
evaluate('writes ok', { runs: 1, compare }, async (c) => {
  await c.send('write ok.txt')
  await expect(c.exec('test -f ok.txt')).toSucceed()
})
`

  test("a run whose only failures are ungated is passed, as reeval run's exit 0 says", async () => {
    const p = await project('studio-ungated', {
      'reeval.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'evals/ok.eval.ts': skilled,
    })
    const ungated = await runCli(p.dir, ['run'])
    assert.equal(ungated.code, 0, ungated.stdout + ungated.stderr)
    const [header] = await listHeaders({
      root: p.dir,
      historyDir: join(p.dir, 'evals/.history'),
      scratch: true,
    })
    assert.ok(header)
    assert.deepEqual([header.summary.fail, header.summary.notGated], [1, 1])
    assert.equal(runOutcome(header), 'pass')
    const recordOf = (h: HistoryEntry) =>
      JSON.parse(readFileSync(join(p.dir, '.reeval/runs', `${h.runId}.json`), 'utf8')) as RunRecord
    // The studio's tree counts the control's miss apart, so the file doesn't read as failed.
    assert.deepEqual(evalTree(recordOf(header))[0]?.tally, {
      pass: 1,
      fail: 0,
      missed: 1,
      infra: 0,
      skipped: 0,
    })

    // Twin: the same failure in a gated control fails the run, and reeval run exits 1.
    const gated = await runCli(p.dir, ['run'], { env: { REEVAL_TEST_GATE_ALL: '1' } })
    assert.equal(gated.code, 1, gated.stdout + gated.stderr)
    const latest = (
      await listHeaders({ root: p.dir, historyDir: join(p.dir, 'evals/.history'), scratch: true })
    ).at(-1)
    assert.ok(latest && latest.runId !== header.runId)
    assert.equal(runOutcome(latest), 'fail')
    assert.deepEqual(evalTree(recordOf(latest))[0]?.tally, {
      pass: 1,
      fail: 1,
      missed: 0,
      infra: 0,
      skipped: 0,
    })
  })

  test('the outcome follows the status too', () => {
    const pass = [{ outcome: 'pass' as const }]
    assert.equal(runOutcome({ status: 'complete', evals: pass }), 'pass')
    assert.equal(runOutcome({ status: 'budget', evals: pass }), 'fail')
    assert.equal(runOutcome({ status: 'interrupted', evals: pass }), 'skipped')
    assert.equal(
      runOutcome({ status: 'complete', evals: [...pass, { outcome: 'infra_error' }] }),
      'infra_error',
    )
    const errors = ['stray rejection']
    assert.equal(
      runOutcome({ status: 'complete', evals: [...pass, { outcome: 'infra_error' }], errors }),
      'fail',
    )
    assert.equal(runOutcome({ status: 'interrupted', evals: pass, errors }), 'skipped')
  })

  test('a run lead names pass, fail, infra and failed judges', () => {
    const judgment = (question: string, verdict: 'pass' | 'fail') => ({
      question,
      verdict,
      score: verdict === 'pass' ? 0.9 : 0.2,
      threshold: 0.8,
      model: 'fake',
      key: question,
    })
    const attempt = (
      outcome: 'pass' | 'fail' | 'infra_error',
      judgements: ReturnType<typeof judgment>[] = [],
    ) => ({ outcome, judgements }) as RunRecord['evals'][number]['attempts'][number]
    const record = (
      summary: Pick<RunRecord['summary'], 'pass' | 'fail' | 'infraError'>,
      attempts: RunRecord['evals'][number]['attempts'],
    ) =>
      ({
        summary: { evals: 1, attempts: attempts.length, notGated: 0, skipped: 0, ...summary },
        evals: [{ attempts }] as RunRecord['evals'],
      }) as Pick<RunRecord, 'summary' | 'evals'>

    const mixed = record({ pass: 9, fail: 2, infraError: 1 }, [
      attempt('pass', [judgment('login?', 'pass')]),
      attempt('fail', [judgment('login?', 'fail')]),
      attempt('fail', [judgment('login?', 'fail'), judgment('checkout?', 'fail')]),
      attempt('infra_error'),
    ])
    assert.deepEqual(failedJudgeLabels(mixed), ['login', 'checkout'])
    assert.equal(
      runLead(mixed),
      '9 of 11 counted attempts passed; 2 failed the login and checkout judges; 1 infra error.',
    )
    assert.equal(
      runLead(record({ pass: 12, fail: 0, infraError: 0 }, [attempt('pass')])),
      '12 of 12 counted attempts passed.',
    )
    assert.equal(
      runLead(record({ pass: 0, fail: 2, infraError: 0 }, [attempt('fail'), attempt('fail')])),
      '0 of 2 counted attempts passed; 2 failed.',
    )
    assert.equal(
      runLead(record({ pass: 0, fail: 0, infraError: 3 }, [attempt('infra_error')])),
      'No counted attempts; 3 infra errors.',
    )
  })

  test('tool calls, files changed and edit tool calls are counted apart', () => {
    assert.equal(
      activityLabel({ tools: 21, fileEdits: 2 }, 2),
      '21 tool calls · 2 files changed · 2 edit tool calls',
    )
    assert.equal(
      activityLabel({ tools: 1, fileEdits: 0 }, 1),
      '1 tool call · 1 file changed · 0 edit tool calls',
    )
  })
})

describe('view-models over a real history', () => {
  test('headers list recorded runs and unrecorded scratch runs, oldest first', () => {
    assert.deepEqual(
      headers.map((h) => h.recorded),
      [true, true, true, false],
    )
    assert.deepEqual(
      headers.map((h) => h.runId),
      [...headers.map((h) => h.runId)].sort(),
    )
    const evalHeader = headers[0]?.evals[0]
    assert.match(evalHeader?.slug ?? '', /^evals-hello-eval-ts-greet-writes-hello-/)
    assert.deepEqual(
      evalHeader?.cells.map((c) => [c.key, c.pass, c.runs]),
      [['fake/fake/fake', 1, 1]],
    )
  })

  test('runs list: newest first, pass counts, drift against the previous complete run', () => {
    const rows = runRows(headers)
    assert.deepEqual(
      rows.map((r) => [r.passed, r.total]),
      [
        [1, 1],
        [4, 4],
        [0, 1],
        [1, 1],
      ],
    )
    // The compare run adds a variant cell: new coverage, while the control it shares is unchanged.
    assert.deepEqual(rows[1]?.drift, [])
    assert.equal(rows[1]?.changedEvals, 0)
    assert.deepEqual(rows[2]?.drift, [])
  })

  test('runs list: a run over a subset of cells is no drift, before or after it', () => {
    const cell = (harness: string, env: string, image: string) => ({
      key: `${harness}/${env}/reeval-tarball`,
      role: 'variant',
      variant: env,
      harness,
      environment: env,
      environmentDigest: `sha256:${env}0000000000000`,
      fingerprint: `${harness}/${env}/${image}`,
      fingerprintParts: { image, agentCli: harness.startsWith('cursor') ? '2026.09' : '1.2.11' },
    })
    const agy = ['reeval-good', 'reeval-weak'].map((e) =>
      cell('antigravity:gemini', e, 'sha256:a1'),
    )
    const cursor = (image: string) =>
      ['reeval-good', 'reeval-weak'].map((e) => cell('cursor:composer', e, image))
    const run = (n: number, cells: ReturnType<typeof cell>[]) =>
      ({
        runId: `2026092${n}T000000Z_abc1234_ci_000${n}`,
        status: 'complete',
        summary: { pass: cells.length, fail: 0, infraError: 0 },
        stack: {
          imageIds: [...new Set(cells.map((c) => c.fingerprintParts.image))],
          agentClis: [...new Set(cells.map((c) => c.fingerprintParts.agentCli))],
          harnesses: [...new Set(cells.map((c) => c.harness))],
          environments: [...new Set(cells.map((c) => `${c.environment}@${c.environment}00000`))],
          judgeModel: 'google/gemini-3.8-flash',
          judgeServed: [],
          judgeVersion: '1',
          threshold: 0.8,
          fingerprintScope: ['sources'],
        },
        evals: [
          {
            id: 'evals/scaffold.eval.ts › scaffolds',
            slug: 'scaffolds',
            outcome: 'pass',
            fingerprint: cells.map((c) => c.fingerprint).join(),
            cells,
          },
        ],
      }) as unknown as HistoryEntry
    const runs = [
      run(1, [...cursor('sha256:c1'), ...agy]),
      run(2, agy.slice(0, 1)),
      run(3, [...cursor('sha256:c2'), ...agy]),
      run(4, agy.slice(0, 1)),
      run(5, [...cursor('sha256:c2'), ...agy]),
    ]
    assert.deepEqual(
      evalHistory(runs, 'scaffolds').map((p) => p.changed),
      [false, false, true, false, false],
    )
    const rows = runRows(runs).reverse()
    assert.deepEqual(
      rows.map((r) => [r.drift.map((c) => `${c.label}: ${c.base} → ${c.head}`), r.changedEvals]),
      [
        [[], 0],
        [[], 0],
        // Measured against the last run that had the Cursor cells, not the subset run before it.
        [['image ids: sha256:c1 → sha256:c2'], 1],
        [[], 0],
        [[], 0],
      ],
    )
  })

  test('eval tree, cells and lift for a multi-cell run', () => {
    const matrix = records.get(headers[2]?.runId as string) as RunRecord
    const tree = evalTree(matrix)
    assert.equal(tree[0]?.kind, 'group')
    assert.equal(tree[0]?.name, 'evals/hello.eval.ts')
    assert.deepEqual(tree[0]?.tally, { pass: 4, fail: 0, missed: 0, infra: 0, skipped: 0 })
    const rows = cellRows(matrix.evals[0] as RunRecord['evals'][number])
    assert.deepEqual(
      rows.map((r) => [r.environment, r.role, r.gated, r.pass, r.runs, r.lift, r.attempts.length]),
      [
        ['plain', 'control', false, 2, 2, null, 2],
        ['other', 'variant', true, 2, 2, 0, 2],
      ],
    )
    assert.deepEqual(
      rows.map((r) => [
        r.usage,
        r.judgeRates.map((k) => [k.label, k.pass, k.counted, k.lift?.points ?? null]),
      ]),
      [
        [null, [['Did it write…', 2, 2, null]]],
        [null, [['Did it write…', 2, 2, 0]]],
      ],
    )
  })

  test('per-key judge rates, collapsed scores and cell usage', () => {
    const j = (question: string, verdict: 'pass' | 'fail', score: number, key: string) => ({
      question,
      verdict,
      score,
      threshold: 0.8,
      model: 'fake',
      key,
    })
    const tokens = { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: null }
    const attempt = (
      cell: string,
      n: number,
      outcome: 'pass' | 'fail',
      login: 'pass' | 'fail',
      usage: typeof tokens | null,
    ) =>
      ({
        id: `${cell}#${n}`,
        cell,
        n,
        outcome,
        usage,
        changedFiles: [],
        judgements: [
          j('login', login, login === 'pass' ? 0.9 : 0.2, '0:login'),
          j('checkout', 'fail', 0.1, '1:checkout'),
        ],
      }) as RunRecord['evals'][number]['attempts'][number]
    const cell = (key: string, role: 'control' | 'variant', env: string) =>
      ({
        key,
        harness: 'fake',
        environment: env,
        sandbox: 'fake',
        role,
      }) as RunRecord['evals'][number]['cells'][number]
    const entry = {
      cells: [
        cell('fake/plain/fake', 'control', 'plain'),
        cell('fake/skill/fake', 'variant', 'skill'),
      ],
      attempts: [
        attempt('fake/plain/fake', 1, 'fail', 'fail', tokens),
        attempt('fake/plain/fake', 2, 'fail', 'pass', tokens),
        attempt('fake/skill/fake', 1, 'pass', 'pass', tokens),
        attempt('fake/skill/fake', 2, 'pass', 'pass', null),
      ],
    } as RunRecord['evals'][number]

    const first = entry.attempts.find((a) => a.id === 'fake/plain/fake#1')
    const skillOne = entry.attempts.find((a) => a.id === 'fake/skill/fake#1')
    assert.ok(first && skillOne)
    assert.equal(judgeLabel('login?'), 'login')
    assert.equal(judgeLabel('Does this change implement email sign-in?'), 'Does this change…')
    assert.equal(collapsedJudgeLabel(first.judgements), 'fail 0.20/0.80 · fail 0.10/0.80')
    assert.equal(
      collapsedJudgeLabel([...first.judgements, j('extra', 'fail', 0.05, '2:extra')]),
      'fail 0.05/0.80 · 3 judges',
    )
    const keyLifts = (e: RunRecord['evals'][number]) =>
      cellJudgeRates(e, 'fake/skill/fake').map((r) => [
        r.label,
        r.pass,
        r.counted,
        r.lift && Math.round(r.lift.points * 100),
      ])
    // A key's lift is its direction at any number of attempts; the interval says whether it holds.
    assert.deepEqual(keyLifts(entry), [
      ['login', 2, 2, 50],
      ['checkout', 0, 2, 0],
    ])
    const four = {
      ...entry,
      attempts: [
        ...entry.attempts,
        attempt('fake/plain/fake', 3, 'fail', 'fail', null),
        attempt('fake/plain/fake', 4, 'fail', 'fail', null),
        attempt('fake/skill/fake', 3, 'pass', 'pass', null),
        attempt('fake/skill/fake', 4, 'pass', 'pass', null),
      ],
    }
    assert.deepEqual(keyLifts(four), [
      ['login', 4, 4, 75],
      ['checkout', 0, 4, 0],
    ])
    const thin = {
      ...entry,
      attempts: [skillOne],
    }
    assert.equal(
      cellJudgeRates(thin, 'fake/skill/fake').every((r) => r.lift === null),
      true,
    )
    assert.deepEqual(cellUsage(entry, 'fake/plain/fake'), {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
    })
    assert.deepEqual(cellUsage(entry, 'fake/skill/fake'), tokens)
    const rows = cellRows({
      ...four,
      attempts: four.attempts.map((a) => ({
        ...a,
        activity: {
          tools: 1,
          fileEdits: 0,
          webSearches: null,
          webFetches: null,
          reasoningMs: 0,
          stalledTools: 0,
          maxToolMs: null,
        },
        timings: { setupMs: 0, agentMs: 100, diffMs: 0, checksMs: 0, judgeMs: 0 },
      })),
    })
    assert.equal(rows[1]?.judgeRates[0]?.lift?.points, 0.75)
    assert.equal(rows[0]?.usage?.input, 100)
  })

  test('colliding judge prefixes take the distinctive tail', () => {
    const email = 'Does this change implement email sign-in?'
    const social = 'Does this change implement social sign-in?'
    const login = 'login?'
    assert.equal(judgeLabel(email), judgeLabel(social))
    assert.deepEqual(
      [
        ...uniqueJudgeLabels([
          { key: '0:email', question: email },
          { key: '1:social', question: social },
          { key: '2:login', question: login },
        ]),
      ],
      [
        ['0:email', '…email sign-in'],
        ['1:social', '…social sign-in'],
        ['2:login', 'login'],
      ],
    )
    assert.deepEqual(
      [
        ...uniqueJudgeLabels([
          { key: '0:same', question: email },
          { key: '1:same', question: email },
        ]),
      ],
      [
        ['0:same', '0:same'],
        ['1:same', '1:same'],
      ],
    )

    const j = (question: string, key: string, verdict: 'pass' | 'fail') => ({
      question,
      verdict,
      score: verdict === 'pass' ? 0.9 : 0.2,
      threshold: 0.8,
      model: 'fake',
      key,
    })
    const attempt = (n: number, emailVerdict: 'pass' | 'fail') =>
      ({
        id: `fake/plain/fake#${n}`,
        cell: 'fake/plain/fake',
        n,
        outcome: 'fail',
        judgements: [j(email, '0:email', emailVerdict), j(social, '1:social', 'fail')],
      }) as RunRecord['evals'][number]['attempts'][number]
    const entry = {
      cells: [{ key: 'fake/plain/fake' }],
      attempts: [attempt(1, 'fail'), attempt(2, 'pass')],
    } as RunRecord['evals'][number]
    assert.deepEqual(
      cellJudgeRates(entry, 'fake/plain/fake').map((r) => [r.label, r.pass, r.counted]),
      [
        ['…email sign-in', 1, 2],
        ['…social sign-in', 0, 2],
      ],
    )
    assert.deepEqual(
      failedJudgeLabels({
        evals: [entry],
      } as Pick<RunRecord, 'evals'>),
      ['…email sign-in', '…social sign-in'],
    )
  })

  test("compare answers: each question's win rates per cut, and nothing without one", () => {
    const matrix = records.get(headers[2]?.runId as string) as RunRecord
    // Both arms pass on both runs: two within pairs, each voted in both orders. The model picks
    // the first slot, so each side wins the order it was shown first in.
    assert.deepEqual(answerRows(matrix.evals[0] as RunRecord['evals'][number]), [
      {
        question: 'Which wrote hello.txt?',
        model: 'fake',
        votes: 4,
        ties: 0,
        within: [
          { name: 'plain', wins: 2, n: 4, rate: 0.5 },
          { name: 'other', wins: 2, n: 4, rate: 0.5 },
        ],
        across: [],
        error: null,
        noPairs: false,
        reasons: [],
        input: `${matrix.evals[0]?.slug}/questions/1.json`,
      },
    ])
    for (const h of [headers[0], headers[1], headers[3]]) {
      const run = records.get(h?.runId as string) as RunRecord
      assert.deepEqual(run.evals.flatMap(answerRows), [], `${h?.runId} asked no question`)
    }
    const withReason = structuredClone(matrix.evals[0] as RunRecord['evals'][number])
    const first = withReason.answers?.[0]?.votes[0]
    if (first) first.reason = 'the other arm writes hello.txt'
    assert.deepEqual(answerRows(withReason)[0]?.reasons, ['the other arm writes hello.txt'])
    const unkept = structuredClone(matrix.evals[0] as RunRecord['evals'][number])
    for (const a of unkept.answers ?? []) delete a.input
    assert.equal(answerRows(unkept)[0]?.input, null, 'a record that kept no files links nothing')
  })

  test('attempt answers: one row per question, choices tallied over the answers that came back', () => {
    const asked = (choice: string | undefined, error?: string) =>
      ({
        question: 'Did it pass?',
        model: 'fake',
        stateOptions: {},
        choices: ['yes', 'no'],
        ...(choice ? { choice } : {}),
        text: error ? '' : 'it wrote ok.txt',
        ...(error ? { error } : {}),
        input: { path: 'e/c/1/questions/1.json', sha256: '', bytes: 0 },
      }) as NonNullable<RunRecord['evals'][number]['attempts'][number]['answers']>[number]
    const attempt = (id: string, outcome: 'pass' | 'fail', answers = [asked('yes')]) =>
      ({ id, outcome, answers }) as RunRecord['evals'][number]['attempts'][number]
    const rows = attemptAnswerRows({
      attempts: [
        attempt('a#1', 'pass'),
        attempt('a#2', 'fail', [asked('no'), { ...asked(undefined), question: 'Why?' }]),
        attempt('a#3', 'pass', [asked(undefined, 'over quota')]),
        { id: 'a#4', outcome: 'infra' } as RunRecord['evals'][number]['attempts'][number],
      ],
    })
    assert.deepEqual(
      rows.map((r) => [
        r.question,
        r.choices,
        r.answers.map((a) => [a.attempt, a.choice, a.error]),
      ]),
      [
        [
          'Did it pass?',
          [
            { choice: 'yes', n: 1 },
            { choice: 'no', n: 1 },
          ],
          [
            ['a#1', 'yes', null],
            ['a#2', 'no', null],
            ['a#3', null, 'over quota'],
          ],
        ],
        [
          'Why?',
          [
            { choice: 'yes', n: 0 },
            { choice: 'no', n: 0 },
          ],
          [['a#2', null, null]],
        ],
      ],
    )
    assert.equal(rows[0]?.answers[0]?.input, 'e/c/1/questions/1.json')
  })

  test("compare answers over real harnesses' diffs (real-e2e-pairs), a failed one and one with no pairs", async () => {
    const [real] = realAttempts('real-e2e-pairs')
    assert.ok(real)
    const answer = await e2eNewlineAnswer()
    const failed = { ...answer, question: 'Which is shorter?', votes: [], rates: [], error: '429' }
    const none = { ...answer, question: 'Which is kinder?', votes: [], rates: [] }
    const rows = answerRows({ ...real.eval, answers: [answer, failed, none] })
    assert.deepEqual(
      rows.map((r) => [r.question, r.votes, r.ties, r.error, r.noPairs]),
      [
        ['Which ends hello.txt with a newline?', 18, 10, null, false],
        ['Which is shorter?', 0, 0, '429', false],
        ['Which is kinder?', 0, 0, null, true],
      ],
    )
    // Within, each harness's two runs tie; across, Codex's newline wins every decided vote.
    assert.deepEqual(rows[0]?.within, [])
    assert.deepEqual(rows[0]?.across, [
      { name: 'cursor', wins: 0, n: 4, rate: 0 },
      { name: 'codex', wins: 8, n: 8, rate: 1 },
      { name: 'claude-code', wins: 0, n: 4, rate: 0 },
    ])
  })

  test('eval history marks where the eval changed', () => {
    const points = evalHistory(headers, headers[0]?.evals[0]?.slug as string)
    assert.deepEqual(
      points.map((p) => [p.outcome, p.changed]),
      [
        ['pass', false],
        ['fail', false],
        // Adding a variant cell, then running without it again, changes no cell they share.
        ['pass', false],
        ['pass', false],
      ],
    )
  })

  test('compare flags the regression and its judge-score delta', () => {
    const [base, head] = headers as [HistoryEntry, HistoryEntry]
    const view = compareView(base, head, {
      base: records.get(base.runId),
      head: records.get(head.runId),
    })
    assert.equal(view.counts.regressed, 1)
    assert.deepEqual(
      view.rows.map((r) => [r.status, r.basePassAt1, r.headPassAt1, r.baseScore, r.headScore]),
      [['regressed', 1, 0, 0.9, 0.2]],
    )
  })

  test('transcripts parse into turns and events, skipping broken lines', async () => {
    const run = records.get(headers[0]?.runId as string) as RunRecord
    const ref = run.evals[0]?.attempts[0]?.files.transcript
    assert.ok(ref)
    const text = await readFile(join(source.historyDir, run.runId, ref.path), 'utf8')
    const items = transcriptItems(parseTranscript(`${text}{"truncated`))
    assert.equal(items[0]?.kind, 'turn')
    assert.equal(items.at(-1)?.kind, 'turn-end')
    assert.ok(items.some((i) => i.kind === 'event' && i.event.type === 'file-edit'))
  })

  test('patches split per file with line counts', () => {
    const files = splitPatch(
      [
        'diff --git a/a.js b/a.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a.js',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        'diff --git a/b.js b/b.js',
        '--- a/b.js',
        '+++ b/b.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    )
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.added, f.removed]),
      [
        ['a.js', 'added', 2, 0],
        ['b.js', 'modified', 1, 1],
      ],
    )
  })

  test("patch lines that start with -- or ++ count, and the file's own header lines don't", () => {
    const [file] = splitPatch(
      [
        'diff --git a/schema.sql b/schema.sql',
        'index 1111111..2222222 100644',
        '--- a/schema.sql',
        '+++ b/schema.sql',
        '@@ -1,3 +1,3 @@',
        '--- drop the legacy table',
        '-DROP TABLE legacy;',
        '+++ counter',
        '+SELECT 1;',
        ' -- unchanged',
        '@@ -9 +9 @@',
        '----',
        '+++i;',
        '',
      ].join('\n'),
    )
    assert.deepEqual([file?.path, file?.added, file?.removed], ['schema.sql', 3, 3])
  })

  test('patches name files git quotes, renames and binaries by their real path', () => {
    const files = splitPatch(
      [
        'diff --git "a/t\\tab \\"q\\".txt" "b/t\\tab \\"q\\".txt"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/t\\tab \\"q\\".txt"',
        '@@ -0,0 +1 @@',
        '+x',
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        'deleted file mode 100644',
        '--- "a/caf\\303\\251.txt"',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x',
        'diff --git a/with space.txt b/with space.txt',
        '--- a/with space.txt\t',
        '+++ b/with space.txt\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/old name.txt b/new name.txt',
        'similarity index 100%',
        'rename from old name.txt',
        'rename to new name.txt',
        'diff --git a/b b/logo b.png b/b b/logo b.png',
        'new file mode 100644',
        'index 0000000..1111111',
        'GIT binary patch',
        'literal 1',
        'IcmZo*0000H00000',
        '',
        'literal 0',
        'HcmV?d00001',
        '',
        '',
      ].join('\n'),
    )
    assert.deepEqual(
      files.map((f) => [f.path, f.status]),
      [
        ['t\tab "q".txt', 'added'],
        ['café.txt', 'deleted'],
        ['with space.txt', 'modified'],
        ['new name.txt', 'renamed'],
        ['b b/logo b.png', 'added'],
      ],
    )
  })
})

const HOST = '127.0.0.1:4984'
const ORIGIN = 'https://studio.example'
const PAIRING = 'pairing-token-0123456789'

type Headers = Record<string, string>

/** A data server over `src`, before pairing: `call` sends as is, with only the Host header. */
function studioApi(src: StudioSource = source, focus: string | null = null) {
  let pairs = 0
  const app = createStudioApi({
    source: src,
    reeval: 'test',
    project: 'studio',
    origin: ORIGIN,
    pairingToken: PAIRING,
    hosts: [HOST],
    focus,
    onPair: () => pairs++,
  })
  const call = (
    path: string,
    init: {
      method?: string
      headers?: Headers
      body?: string | ReadableStream<Uint8Array>
      duplex?: 'half'
    } = {},
  ) => app.request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...init.headers } })
  const pair = (token: string, headers: Headers = { origin: ORIGIN }) =>
    call(studioPaths.pair(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ token }),
    })
  return { call, pair, pairs: () => pairs }
}

/** A data server over `src`, paired as the hosted page pairs: `get` sends its session and origin. */
async function paired(src: StudioSource = source) {
  const api = studioApi(src)
  const res = await api.pair(PAIRING)
  assert.equal(res.status, 200, await res.clone().text())
  const body = (await res.json()) as PairResponse
  const get = (path: string, headers: Headers = {}) =>
    api.call(path, {
      headers: { authorization: `Bearer ${body.session}`, origin: ORIGIN, ...headers },
    })
  return { ...api, get, body }
}

const json = async <T>(res: Response) => {
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as T
}

describe('studio API contract', () => {
  test('every path builder parses back to its route, attempt keys of any character included', () => {
    const key = 'evals/hello.eval.ts › greet › writes hello [case 1] # fake/a b#1 100%'
    assert.deepEqual(parseStudioPath(studioPaths.pair()), { route: 'pair' })
    assert.deepEqual(parseStudioPath(studioPaths.handshake()), { route: 'handshake' })
    assert.deepEqual(parseStudioPath(studioPaths.runs()), { route: 'runs' })
    assert.deepEqual(parseStudioPath(studioPaths.run(RUN)), { route: 'run', runId: RUN })
    assert.deepEqual(parseStudioPath(studioPaths.attempt(RUN, key)), {
      route: 'attempt',
      runId: RUN,
      attemptKey: key,
    })
    assert.deepEqual(parseStudioPath(studioPaths.transcript(RUN, key)), {
      route: 'transcript',
      runId: RUN,
      attemptKey: key,
    })
    assert.deepEqual(
      parseStudioPath(studioPaths.artifact(RUN, 'my-eval/fake-x/1/transcript.jsonl')),
      {
        route: 'artifact',
        runId: RUN,
        segments: ['my-eval', 'fake-x', '1', 'transcript.jsonl'],
      },
    )
    assert.deepEqual(
      [...new Set(Object.keys(studioPaths))].sort(),
      [...STUDIO_ROUTES].sort(),
      'a path builder for every route',
    )
  })

  test('traversal, odd segments, bad run ids and unknown routes name nothing', () => {
    for (const path of [
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/../x`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/./x`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/a//b`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/%2e%2e/x`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/a%2fb`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts/${'a/'.repeat(9)}x`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/artifacts`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/attempts/%00`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/attempts/%E0%A4%A`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/attempts/`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/attempts/x/other`,
      `${STUDIO_API_PREFIX}/runs/not-a-run/view`,
      `${STUDIO_API_PREFIX}/runs/${RUN}`,
      `${STUDIO_API_PREFIX}/runs/${RUN}/view/x`,
      `${STUDIO_API_PREFIX}/other`,
      '/api/v2/runs',
      '/studio.json',
      '',
    ]) {
      assert.equal(parseStudioPath(path), null, path)
    }
  })

  test('list limits default when absent or bad and clamp to the maximum', () => {
    assert.equal(pageLimit(undefined, RUN_LIST_LIMIT), RUN_LIST_LIMIT.default)
    assert.equal(pageLimit('abc', RUN_LIST_LIMIT), RUN_LIST_LIMIT.default)
    assert.equal(pageLimit('-3', RUN_LIST_LIMIT), RUN_LIST_LIMIT.default)
    assert.equal(pageLimit('2', RUN_LIST_LIMIT), 2)
    assert.equal(pageLimit('100000', TRANSCRIPT_LIMIT), TRANSCRIPT_LIMIT.max)
  })
})

describe('buildRunView', () => {
  test('carries every eval, cell and attempt of the record, with the header the history lists', () => {
    for (const h of headers) {
      const record = records.get(h.runId) as RunRecord
      const view = buildRunView(record, { recorded: h.recorded })
      assert.equal(view.viewVersion, VIEW_VERSION)
      assert.deepEqual(view.header, runHeader(record, h.recorded))
      assert.deepEqual(view.header, h)
      assert.deepEqual(
        view.evals.map((e) => [e.key, e.cells.map((c) => c.key), e.attempts.map((a) => a.key)]),
        record.evals.map((e) => [e.key, e.cells.map((c) => c.key), e.attempts.map((a) => a.key)]),
      )
      for (const e of view.evals) {
        const source = record.evals.find((x) => x.key === e.key) as RunRecord['evals'][number]
        for (const c of e.cells) assert.deepEqual(c.effortStats, cellEffort(source, c.key))
        for (const a of e.attempts) {
          const rec = source.attempts.find((x) => x.key === a.key)
          assert.equal(a.evalKey, e.key)
          assert.equal(a.facts, null, 'no facts without transcripts')
          assert.equal(a.transcript, !!rec?.files.transcript)
          assert.equal(a.assertions.passed + a.assertions.failed, rec?.assertions?.length ?? 0)
          assert.equal(a.judgements.passed + a.judgements.failed, rec?.judgements.length)
        }
      }
      const passed = view.evals.flatMap((e) => e.attempts).filter((a) => a.outcome === 'pass')
      assert.equal(passed.length, record.summary.pass)
    }
  })

  test('is pure: the same record gives the same view and is left as it was', () => {
    const record = records.get(headers[2]?.runId as string) as RunRecord
    const before = JSON.stringify(record)
    const first = record.evals[0]?.attempts[0] as RunRecord['evals'][number]['attempts'][number]
    const transcripts = new Map([[first.key, '']])
    const a = buildRunView(record, { recorded: true, transcripts })
    const b = buildRunView(structuredClone(record), { recorded: true, transcripts })
    assert.deepEqual(a, b)
    assert.equal(JSON.stringify(record), before)
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the view is plain JSON')
    assert.deepEqual(a.evals[0]?.attempts[0]?.facts, attemptFacts(record, first, ''))
    assert.equal(a.evals[0]?.attempts[0]?.facts?.toolCalls, 0)
    assert.equal(a.evals[0]?.attempts[1]?.facts ?? null, null)
  })

  test("facts classify the transcript's calls, as `reeval query` does, from the record alone", () => {
    const record = records.get(headers[0]?.runId as string) as RunRecord
    const attempt = record.evals[0]?.attempts[0] as RunRecord['evals'][number]['attempts'][number]
    const tool = (input: object, name = 'read') =>
      JSON.stringify({ type: 'tool', tool: name, input, ok: true })
    const transcript = [
      JSON.stringify({ type: 'text', text: 'start' }),
      tool({ path: '.claude/skills/s/SKILL.md' }),
      tool({ command: 'npm test' }, 'shell'),
      'not json',
      tool({ path: '.claude/skills/s/SKILL.md' }),
    ].join('\n')
    const facts = attemptFacts(record, attempt, transcript)
    assert.deepEqual(facts, {
      toolCalls: 3,
      byClass: { context: 2, dependency: 0, web: 0, verify: 1, workspace: 0 },
      skills: [{ skill: 's', source: 'skill-dir', reads: 2, firstLine: 2 }],
      contextFiles: [],
    })
    const view = buildAttemptView(record, attempt.key, transcript)
    assert.deepEqual(view?.facts, facts)
  })

  test("an attempt's view drops turns and context and lists every file its record names", () => {
    const record = records.get(headers[0]?.runId as string) as RunRecord
    const attempt = record.evals[0]?.attempts[0] as RunRecord['evals'][number]['attempts'][number]
    const view = buildAttemptView(record, attempt.key)
    assert.ok(view)
    assert.equal('context' in view, false)
    assert.equal(view.turns, attempt.turns.length)
    assert.equal(view.contextFiles, attempt.context.length)
    assert.ok(view.fileRefs.some((f) => f.path === attempt.files.transcript?.path))
    assert.equal(new Set(view.fileRefs.map((f) => f.path)).size, view.fileRefs.length)
    assert.equal(buildAttemptView(record, 'no such attempt'), null)
  })
})

describe('studio data server', () => {
  test('the pairing token trades once for a session, and only the right one does', async () => {
    const api = studioApi()
    assert.equal((await api.pair('wrong-token')).status, 401)
    assert.equal(
      (
        await api.call(studioPaths.pair(), {
          method: 'POST',
          headers: { origin: ORIGIN },
          body: '{',
        })
      ).status,
      400,
    )
    const ok = await api.pair(PAIRING)
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as PairResponse
    assert.match(body.session, /^[\w-]{40,}$/)
    assert.notEqual(body.session, PAIRING)
    assert.deepEqual(body.handshake, {
      api: STUDIO_API_VERSION,
      viewVersion: VIEW_VERSION,
      reeval: 'test',
      project: 'studio',
      routes: [...STUDIO_ROUTES],
      focus: headers.at(-1)?.runId,
    })
    assert.equal((await api.pair(PAIRING)).status, 409, 'the token is spent')
    assert.equal(api.pairs(), 1)
  })

  test('a pairing body past 1 KB is refused without reading the rest of it', async () => {
    const api = studioApi()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 1000) controller.close()
        else controller.enqueue(new Uint8Array(512).fill(0x20))
      },
    })
    const res = await api.call(studioPaths.pair(), {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    })
    assert.equal(res.status, 413)
    assert.ok(pulled <= 4, `read ${pulled} chunks of 512 bytes`)
    const declared = await api.call(studioPaths.pair(), {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-length': '1025' },
      body: ' '.repeat(1025),
    })
    assert.equal(declared.status, 413)
    assert.equal((await api.pair(PAIRING)).status, 200, 'the token is still unspent')
  })

  test('every route but pair needs the session; the pairing token is not one', async () => {
    const api = await paired()
    const key = records.get(headers[0]?.runId as string)?.evals[0]?.attempts[0]?.key as string
    const routes = [
      studioPaths.handshake(),
      studioPaths.runs(),
      studioPaths.run(headers[0]?.runId as string),
      studioPaths.attempt(headers[0]?.runId as string, key),
      studioPaths.transcript(headers[0]?.runId as string, key),
    ]
    for (const path of routes) {
      assert.equal((await api.get(path)).status, 200, path)
      for (const auth of [
        undefined,
        'Bearer ',
        'Bearer wrong',
        `Bearer ${PAIRING}`,
        api.body.session,
      ]) {
        const headers: Headers = {
          origin: ORIGIN,
          ...(auth === undefined ? {} : { authorization: auth }),
        }
        const res = await api.call(path, { headers })
        assert.equal(res.status, 401, `${path} with ${auth}`)
        assert.equal(
          res.headers.get('access-control-allow-origin'),
          ORIGIN,
          'the page can read why',
        )
      }
    }
  })

  test('CORS answers only the hosted origin, and a foreign host is refused', async () => {
    const api = await paired()
    const preflight = await api.call(studioPaths.runs(), {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
        'access-control-request-private-network': 'true',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN)
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/)
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
    const served = await api.get(studioPaths.runs())
    assert.equal(served.headers.get('access-control-allow-origin'), ORIGIN)
    assert.equal(served.headers.get('vary'), 'Origin')

    for (const origin of [
      'https://evil.example',
      'http://studio.example',
      `${ORIGIN}.evil`,
      'null',
    ]) {
      const pre = await api.call(studioPaths.runs(), { method: 'OPTIONS', headers: { origin } })
      assert.equal(pre.status, 403, origin)
      assert.equal(pre.headers.get('access-control-allow-origin'), null, origin)
      const res = await api.get(studioPaths.runs(), { origin })
      assert.equal(res.status, 403, origin)
      assert.equal(res.headers.get('access-control-allow-origin'), null, origin)
      assert.equal((await studioApi().pair(PAIRING, { origin })).status, 403, origin)
    }
    for (const host of ['evil.example:4984', '127.0.0.1:1', 'localhost']) {
      assert.equal((await api.get(studioPaths.runs(), { host })).status, 403, host)
    }
    assert.equal((await api.call(studioPaths.runs(), { method: 'POST' })).status, 405)
    assert.equal((await api.call(studioPaths.pair())).status, 405)
  })

  test('serves runs newest first a page at a time, and each run as buildRunView builds it', async () => {
    const api = await paired()
    const all = await json<RunList>(await api.get(studioPaths.runs()))
    assert.deepEqual(
      all.items.map((h) => h.runId),
      headers.map((h) => h.runId).reverse(),
    )
    assert.equal(all.next, null)
    const first = await json<RunList>(await api.get(`${studioPaths.runs()}?limit=3`))
    assert.equal(first.items.length, 3)
    const rest = await json<RunList>(
      await api.get(`${studioPaths.runs()}?limit=3&cursor=${first.next}`),
    )
    assert.deepEqual([...first.items, ...rest.items], all.items)
    assert.equal(rest.next, null)

    for (const h of headers) {
      const view = await json<RunView>(await api.get(studioPaths.run(h.runId)))
      const record = records.get(h.runId) as RunRecord
      const withoutFacts = buildRunView(record, { recorded: h.recorded })
      const strip = (v: RunView) => ({
        ...v,
        evals: v.evals.map((e) => ({
          ...e,
          attempts: e.attempts.map((a) => ({ ...a, facts: null })),
        })),
      })
      assert.deepEqual(strip(view), JSON.parse(JSON.stringify(withoutFacts)))
      for (const a of view.evals.flatMap((e) => e.attempts)) {
        assert.equal(
          a.facts !== null,
          a.transcript,
          `${a.key}: facts wherever a transcript was kept`,
        )
      }
    }
    assert.equal((await api.get(studioPaths.run('20200101T000000Z_abc1234_x_k3f9'))).status, 404)
  })

  test("each attempt's facts are the tool calls history.db classifies", async () => {
    const api = await paired()
    const runId = headers[0]?.runId as string
    const r = await runCli(dir, [
      'query',
      `SELECT attempt_key, class, COUNT(*) AS n FROM tool_calls WHERE run_id = '${runId}' GROUP BY 1, 2`,
      '--json',
    ])
    assert.equal(r.code, 0, r.stderr)
    const rows = JSON.parse(r.stdout) as Array<{ attempt_key: string; class: string; n: number }>
    assert.ok(rows.length > 0, `the fake agent made tool calls: ${r.stdout}`)
    const view = await json<RunView>(await api.get(studioPaths.run(runId)))
    for (const a of view.evals.flatMap((e) => e.attempts)) {
      const mine = rows.filter((row) => row.attempt_key === a.key)
      for (const [cls, n] of Object.entries(a.facts?.byClass ?? {})) {
        assert.equal(n, mine.find((row) => row.class === cls)?.n ?? 0, `${a.key} ${cls}`)
      }
    }
  })

  test('serves an attempt, its transcript a page at a time, and its files as untrusted bytes', async () => {
    const api = await paired()
    const runId = headers[0]?.runId as string
    const record = records.get(runId) as RunRecord
    const attempt = record.evals[0]?.attempts[0] as RunRecord['evals'][number]['attempts'][number]
    const view = await json<AttemptView>(await api.get(studioPaths.attempt(runId, attempt.key)))
    assert.equal(view.key, attempt.key)
    assert.ok(view.facts)
    assert.equal(
      (await api.get(studioPaths.attempt(runId, `${attempt.key}0`))).status,
      404,
      'an unknown attempt',
    )

    const lines = parseTranscript(
      await readFile(
        join(source.historyDir, runId, attempt.files.transcript?.path as string),
        'utf8',
      ),
    )
    const whole = await json<AttemptTrace>(
      await api.get(studioPaths.transcript(runId, attempt.key)),
    )
    assert.deepEqual(whole, {
      items: JSON.parse(JSON.stringify(lines)),
      next: null,
      totalLines: lines.length,
    })
    const page = await json<AttemptTrace>(
      await api.get(`${studioPaths.transcript(runId, attempt.key)}?limit=1&cursor=1`),
    )
    assert.deepEqual(page.items, whole.items.slice(1, 2))
    assert.equal(page.next, lines.length > 2 ? '2' : null)

    const file = await api.get(
      studioPaths.artifact(runId, attempt.files.transcript?.path as string),
    )
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-security-policy'), 'sandbox')
    assert.equal(file.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
    const summary = await api.get(studioPaths.artifact(runId, 'summary.md'))
    assert.equal(summary.headers.get('content-type'), 'text/plain; charset=utf-8')
  })

  test('traversal, encoded tricks and symlinks out of a run never reach a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reeval-studio-api-'))
    await cp(source.historyDir, join(root, 'evals/.history'), { recursive: true })
    const runId = headers[0]?.runId as string
    writeFileSync(join(root, 'secret.txt'), 'secret')
    await symlink(join(root, 'secret.txt'), join(root, 'evals/.history', runId, 'leak.txt'))
    const linked = '20260101T000000Z_abc1234_x_k3f9'
    await symlink(join(root, 'evals/.history', runId), join(root, 'evals/.history', linked))
    writeFileSync(
      join(root, 'evals/.history', `${linked}.json`),
      readFileSync(join(root, 'evals/.history', `${runId}.json`)),
    )
    const api = await paired({ root, historyDir: join(root, 'evals/.history'), scratch: false })
    for (const path of [
      studioPaths.artifact(runId, 'leak.txt'),
      studioPaths.artifact(linked, 'summary.md'),
      `${STUDIO_API_PREFIX}/runs/${runId}/artifacts/..%2f..%2fsecret.txt`,
      `${STUDIO_API_PREFIX}/runs/${runId}/artifacts/%2e%2e/%2e%2e/secret.txt`,
      `${STUDIO_API_PREFIX}/runs/${runId}/artifacts/../../secret.txt`,
      `${STUDIO_API_PREFIX}/runs/${runId}.json/artifacts/x`,
    ]) {
      const res = await api.get(path)
      assert.equal(res.status, 404, path)
      assert.doesNotMatch(await res.text(), /secret/, path)
    }
    assert.equal((await api.get(studioPaths.artifact(runId, 'summary.md'))).status, 200)
  })
})

describe('a record landing while the studio lists runs', () => {
  test("Windows refusing the cache's rename or a record's read skips it until the next read", async () => {
    const root = await mkdtemp(join(tmpdir(), 'reeval-landing-'))
    await cp(source.historyDir, join(root, 'evals/.history'), { recursive: true })
    await cp(join(dir, '.reeval/runs'), join(root, '.reeval/runs'), { recursive: true })
    const fresh: StudioSource = { root, historyDir: join(root, 'evals/.history'), scratch: true }
    const [landing] = headers
    const landingFile = `${(landing as HistoryEntry).runId}.json`
    const refuse = (code: string) => Object.assign(new Error(`${code}: refused`), { code })
    const readFileOf = fsp.readFile
    mock.method(fsp, 'rename', async () => {
      throw refuse('EPERM')
    })
    mock.method(fsp, 'readFile', (async (path: string, ...rest: []) => {
      if (String(path).endsWith(landingFile)) throw refuse('EBUSY')
      return readFileOf(path, ...rest)
    }) as typeof fsp.readFile)
    syncBuiltinESMExports()
    try {
      const listed = await listHeaders(fresh)
      assert.deepEqual(
        listed.map((h) => h.runId),
        headers.map((h) => h.runId).filter((id) => id !== landing?.runId),
      )
      const res = await (await paired(fresh)).get(studioPaths.runs())
      assert.equal(res.status, 200)
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.equal(existsSync(join(root, '.reeval/history-cache.json')), false)
    assert.deepEqual(
      readdirSync(join(root, '.reeval')).filter((n) => n.startsWith('history-cache')),
      [],
      'no temporary cache file is left behind',
    )
    assert.deepEqual(
      (await listHeaders(fresh)).map((h) => h.runId),
      headers.map((h) => h.runId),
    )
  })
})

describe('reeval studio', () => {
  test("says why the page may not have paired and where the run's report is", () => {
    const lines = handshakeTimeoutLines('http://127.0.0.1:4984', '.reeval/runs/r1/summary.md')
    assert.match(
      lines[0] as string,
      /hasn't connected yet: .* reaching http:\/\/127\.0\.0\.1:4984\./,
    )
    assert.ok(lines.some((l) => /Chrome and Firefox ask first .*choose Allow/.test(l)))
    assert.ok(lines.some((l) => /Safari can't reach a local server from a secure page/.test(l)))
    assert.equal(lines.at(-1), "The run's Markdown report is at .reeval/runs/r1/summary.md")
    assert.ok(
      handshakeTimeoutLines('http://127.0.0.1:4984', null).every((l) => !/report/.test(l)),
      'no report line when the run has no summary.md',
    )
  })

  test('serves on 127.0.0.1 only, and names that address rather than localhost', async () => {
    const studio = await startStudio({
      source,
      port: 47330,
      reeval: 'test',
      project: 'studio',
      studioUrl: new URL(`${ORIGIN}/studio`),
      focus: null,
    })
    try {
      assert.equal(studio.address.address, '127.0.0.1')
      assert.equal(studio.server, `http://127.0.0.1:${studio.address.port}`)
      assert.equal(new URL(studio.url).searchParams.get('s'), studio.server)
      const outside = Object.values(networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
      for (const host of ['127.0.0.1', ...(outside ? [outside] : [])]) {
        const reached = await new Promise<boolean>((resolve) => {
          const socket = connect({ host, port: studio.address.port })
          const done = (ok: boolean) => {
            socket.destroy()
            resolve(ok)
          }
          socket.once('connect', () => done(true)).once('error', () => done(false))
          socket.setTimeout(2000, () => done(false))
        })
        assert.equal(reached, host === '127.0.0.1', host)
      }
    } finally {
      studio.close()
    }
  })

  test('opens the hosted page with its server and a one-time token, and says when it never pairs', async () => {
    assert.ok(existsSync(join(pkgRoot, 'dist/cli.js')), 'run pnpm build first')
    const bin = await mkdtemp(join(tmpdir(), 'reeval-opener-'))
    const opened = join(bin, 'opened.txt')
    for (const name of ['xdg-open', 'open']) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const child = spawn(
      process.execPath,
      [join(pkgRoot, 'dist/cli.js'), 'studio', '--port', '47311'],
      {
        cwd: dir,
        env: { ...baseEnv, PATH: `${bin}:${process.env.PATH}`, REEVAL_CLOUD_URL: ORIGIN },
      },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const until = async (pattern: RegExp, ms: number) => {
      const deadline = Date.now() + ms
      while (!pattern.test(out)) {
        assert.ok(Date.now() < deadline, `never printed ${pattern}: ${out}`)
        await new Promise((r) => setTimeout(r, 50))
      }
      return pattern.exec(out) as RegExpExecArray
    }
    try {
      const printed = (await until(/https:\/\/studio\.example\/studio\?\S+/, 20_000))[0]
      const url = new URL(printed)
      const server = url.searchParams.get('s') as string
      const port = Number(/serving http:\/\/127\.0\.0\.1:(\d+) /.exec(out)?.[1])
      assert.ok(port >= 47311, out)
      assert.equal(server, `http://127.0.0.1:${port}`)
      const deadline = Date.now() + 5000
      while (!existsSync(opened) || !readFileSync(opened, 'utf8')) {
        assert.ok(Date.now() < deadline, 'the browser was never opened')
        await new Promise((r) => setTimeout(r, 50))
      }
      const openedUrl = new URL(readFileSync(opened, 'utf8'))
      assert.equal(openedUrl.toString(), printed)
      assert.equal(openedUrl.searchParams.get('s'), `http://127.0.0.1:${port}`)
      assert.equal(url.searchParams.get('run'), headers.at(-1)?.runId)
      const token = new URLSearchParams(url.hash.slice(1)).get('t') as string
      assert.match(token, /^[\w-]{40,}$/)
      assert.doesNotMatch(url.search, new RegExp(token), 'the token is only in the fragment')

      await until(/hasn't connected yet/, 15_000)
      await until(/Markdown report is at/, 5_000)
      assert.match(
        out,
        /Chrome and Firefox ask first whether the page may reach apps on your device/,
      )
      assert.match(
        out,
        new RegExp(`Markdown report is at \\.reeval/runs/${headers.at(-1)?.runId}/summary\\.md`),
      )

      const local = server
      const pair = await fetch(`${local}${studioPaths.pair()}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      assert.equal(pair.status, 200)
      const { session } = (await pair.json()) as PairResponse
      await until(/Paired with the studio page/, 5_000)
      const runs = await fetch(`${local}${studioPaths.runs()}`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${session}` },
      })
      assert.equal(runs.status, 200)
      assert.equal(runs.headers.get('access-control-allow-origin'), ORIGIN)
      assert.equal(((await runs.json()) as RunList).items.length, headers.length)
    } finally {
      child.kill('SIGINT')
    }
  })
})
