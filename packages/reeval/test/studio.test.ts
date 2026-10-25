import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import fsp, { cp, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { before, describe, mock, test } from 'node:test'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { appFiles } from '../src/studio/app.ts'
import { COOKIE, createStudioApp } from '../src/studio/server.ts'
import { listHeaders, type StudioSource } from '../src/studio/source.ts'
import type { AnalysisNote } from '../src/view/analysis.ts'
import {
  activityLabel,
  analysisDataPath,
  answerRows,
  artifactPath,
  attemptAnswerRows,
  buildIndex,
  cellJudgeRates,
  cellRows,
  cellUsage,
  collapsedJudgeLabel,
  compareView,
  type DebugView,
  debugApiPath,
  evalHistory,
  evalTree,
  failedJudgeLabels,
  judgeLabel,
  manifestPath,
  parseDataPath,
  parseTranscript,
  recordPath,
  runLead,
  runOutcome,
  runRows,
  shardPath,
  splitPatch,
  traceApiPath,
  transcriptItems,
  uniqueJudgeLabels,
} from '../src/view/index.ts'
import { baseEnv, fakeConfig, pkgRoot, project, runCli } from './helpers.ts'
import { e2eNewlineAnswer, realAttempts } from './support/real-runs.ts'

const RUN = '20260924T220414Z_f7e1b53_elliot-hesp_k3f9'

describe('studio data paths', () => {
  test('map the file layout and nothing else', () => {
    assert.deepEqual(parseDataPath('studio.json'), { kind: 'studio' })
    assert.deepEqual(parseDataPath(manifestPath), { kind: 'manifest' })
    assert.deepEqual(parseDataPath(shardPath('2026-09')), { kind: 'shard', id: '2026-09' })
    assert.deepEqual(parseDataPath(recordPath(RUN)), { kind: 'record', runId: RUN })
    assert.deepEqual(parseDataPath(artifactPath(RUN, 'my-eval-abc123/fake-x/1/transcript.jsonl')), {
      kind: 'artifact',
      runId: RUN,
      segments: ['my-eval-abc123', 'fake-x', '1', 'transcript.jsonl'],
    })
  })

  test('reject traversal, odd segments and unknown areas', () => {
    for (const path of [
      `data/runs/${RUN}/../../reeval.config.ts`,
      `data/runs/${RUN}/./summary.md`,
      `data/runs/${RUN}//summary.md`,
      `data/runs/${RUN}/.hidden`,
      `data/runs/${RUN}/a\\b`,
      `data/runs/${RUN}/a\0b`,
      `data/runs/${RUN}/${'a/'.repeat(9)}x`,
      'data/runs/../secrets.json',
      'data/runs/not-a-run.json',
      'data/runs/not-a-run/summary.md',
      'data/index/latest.json',
      'data/index/2026-09/x.json',
      'data/other/x.json',
      '../data/index/manifest.json',
      '/etc/passwd',
      '',
    ]) {
      assert.equal(parseDataPath(path), null, path)
    }
  })
})

// A real history: three recorded runs of the fake agent (pass, fail, a control and a variant ×
// two runs, with a compare question) and one scratch run.
const evalFile = `import { defineEnvironment, evaluate, expect, group } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const other = defineEnvironment('other', { sandbox })
group('greet', process.env.REEVAL_TEST_COMPARE ? { compare: { baseline: plain, variants: [other] }, questions: [{ question: 'Which wrote hello.txt?', across: 'environment' }], runs: 2 } : {}, () => {
  evaluate('writes hello', async (c) => {
    await c.send('write hello.txt')
    await expect(c.exec('test -f hello.txt')).toSucceed()
    expect(await c.judge('Did it write hello.txt?')).toPass()
  })
})
`
const agent = "{ files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it' }"

let dir = ''
let source: StudioSource
let headers: HistoryEntry[]
const records = new Map<string, RunRecord>()

before(async () => {
  const p = await project('studio', {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    // The question's model picks whichever attempt it's shown first.
    'reeval.config.ts': fakeConfig({
      harness: agent,
      extra: "analysis: { model: { kind: 'fake-analysis', vote: 'A' } },",
    }),
    'evals/hello.eval.ts': evalFile,
    'reeval.fail.config.ts': fakeConfig({
      harness: agent,
      judge: '{ model: fakeJudge({ score: 0.2 }) }',
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
  ? { baseline: plain, variants: [skilled], gate: 'all' as const }
  : { baseline: plain, variants: [skilled] }
evaluate('writes ok', { compare }, async (c) => {
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
    const judgement = (question: string, verdict: 'pass' | 'fail') => ({
      question,
      verdict,
      score: verdict === 'pass' ? 0.9 : 0.2,
      threshold: 0.8,
      model: 'fake',
      key: question,
    })
    const attempt = (
      outcome: 'pass' | 'fail' | 'infra_error',
      judgements: ReturnType<typeof judgement>[] = [],
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
      attempt('pass', [judgement('login?', 'pass')]),
      attempt('fail', [judgement('login?', 'fail')]),
      attempt('fail', [judgement('login?', 'fail'), judgement('checkout?', 'fail')]),
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
    const runPage = readFileSync(join(pkgRoot, '../studio-web/src/pages/run.tsx'), 'utf8')
    assert.match(runPage, /runLead\(record\)/)
    assert.match(runPage, /pinnedAnalysis/)
  })

  test('the run page leads with a verdict, then the stats', () => {
    const runPage = readFileSync(join(pkgRoot, '../studio-web/src/pages/run.tsx'), 'utf8')
    const lead = runPage.indexOf('runLead(record)')
    const tally = runPage.indexOf('{pass}</span> passed')
    assert.ok(lead > 0 && tally > lead, 'the one-line verdict sits above the pass/fail tally')
  })

  test('tool calls and file edits are counted apart, on every page', () => {
    assert.equal(activityLabel({ tools: 21, fileEdits: 2 }), '21 tool calls · 2 file edits')
    assert.equal(activityLabel({ tools: 1, fileEdits: 0 }), '1 tool call · 0 file edits')
    const pages = ['pages/run.tsx', 'pages/attempt/index.tsx'].map((f) =>
      readFileSync(join(pkgRoot, '../studio-web/src', f), 'utf8'),
    )
    for (const page of pages) {
      assert.match(page, /activityLabel\((a|attempt)\.activity\)/)
      assert.doesNotMatch(page, /'tool call'/, 'no page counts tool calls its own way')
    }
    const runPage = readFileSync(join(pkgRoot, '../studio-web/src/pages/run.tsx'), 'utf8')
    assert.match(runPage, /formatUsage\(a\.usage\)/)
    assert.match(runPage, /formatUsage\(row\.usage\)/)
    assert.match(runPage, /row\.judgeRates/)
    assert.match(runPage, /collapsedJudges\(a\.judgements\)/)
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

  test('the index shards by UTC month, newest first, with an eval catalog', () => {
    const { manifest, shards } = buildIndex(headers, '2026-01-01T00:00:00.000Z')
    const month = headers[0]?.startedAt.slice(0, 7) as string
    assert.deepEqual(manifest.shards, [{ id: month, runs: 4 }])
    assert.equal(manifest.latest, headers[3]?.runId)
    assert.deepEqual(
      shards.get(month)?.map((h) => h.runId),
      headers.map((h) => h.runId).reverse(),
    )
    assert.equal(manifest.evals.length, 1)
    assert.deepEqual(manifest.evals[0]?.path, ['greet', 'writes hello'])
    assert.equal(manifest.evals[0]?.runs, 4)
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
        [null, [['Did it write…', 2, 2, null]]],
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
    // 2 against 2 is below EFFECT_MIN_COUNTED, so no key's lift is measured.
    assert.deepEqual(keyLifts(entry), [
      ['login', 2, 2, null],
      ['checkout', 0, 2, null],
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
      attempts: [first, skillOne],
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
})

const HOST = '127.0.0.1:4984'
const TOKEN = 'test-token-0123456789'

const fakeApp = () =>
  appFiles({
    'index.html': '<!doctype html><title>studio</title>',
    'assets/app.js': 'console.log(1)',
  })

describe('studio server', () => {
  let app: ReturnType<typeof createStudioApp>
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, cookie: `${COOKIE}=${TOKEN}`, ...headers },
    })

  before(async () => {
    app = createStudioApp({
      source,
      app: fakeApp(),
      reeval: 'test',
      project: 'studio',
      token: TOKEN,
      hosts: [HOST, 'localhost:4984'],
    })
  })

  test('a token in the URL becomes an httpOnly cookie and is stripped', async () => {
    const res = await app.request(`http://${HOST}/?token=${TOKEN}`, { headers: { host: HOST } })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/')
    const cookie = res.headers.get('set-cookie') ?? ''
    assert.match(cookie, new RegExp(`^${COOKIE}=${TOKEN}`))
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
  })

  test('every route needs the token', async () => {
    for (const path of ['/', '/studio.json', `/${manifestPath}`, '/api/events']) {
      const res = await app.request(`http://${HOST}${path}`, { headers: { host: HOST } })
      assert.equal(res.status, 401, path)
    }
    assert.equal((await get('/studio.json', { cookie: `${COOKIE}=nope` })).status, 401)
    const badQuery = await app.request(`http://${HOST}/?token=nope`, { headers: { host: HOST } })
    assert.equal(badQuery.status, 401)
  })

  test('foreign hosts and origins, and anything but GET, are refused', async () => {
    assert.equal((await get('/studio.json', { host: 'evil.example:4984' })).status, 403)
    assert.equal((await get('/studio.json', { origin: 'http://evil.example' })).status, 403)
    assert.equal((await get('/studio.json', { origin: `http://${HOST}` })).status, 200)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal((await get('/studio.json', {}, method)).status, 405, method)
    }
    const res = await get('/studio.json')
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  })

  test('serves the app with a strict CSP, the index, records and artifacts', async () => {
    const index = await get('/')
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(await index.text(), '<!doctype html><title>studio</title>')
    assert.equal(index.headers.get('cache-control'), 'no-cache')
    const script = await get('/assets/app.js')
    assert.equal(script.status, 200)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.match(script.headers.get('cache-control') ?? '', /immutable/)
    const scriptTag = script.headers.get('etag') as string
    assert.equal((await get('/assets/app.js', { 'if-none-match': scriptTag })).status, 304)
    assert.equal((await get('/assets/missing.js')).status, 404)
    const info = await (await get('/studio.json')).json()
    assert.equal(info.mode, 'live')
    assert.equal(info.features.scratch, true)
    const manifest = await (await get(`/${manifestPath}`)).json()
    assert.equal(manifest.shards[0].runs, 4)
    const scratch = headers[3]?.runId as string
    const record = await get(`/${recordPath(scratch)}`)
    assert.equal(record.status, 200)
    assert.equal((await record.json()).runId, scratch)

    const run = records.get(headers[0]?.runId as string) as RunRecord
    const ref = run.evals[0]?.attempts[0]?.files.diff
    assert.ok(ref)
    const artifact = await get(`/${artifactPath(run.runId, ref.path)}`)
    assert.equal(artifact.status, 200)
    assert.equal(artifact.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(artifact.headers.get('content-security-policy'), 'sandbox')
    assert.equal(artifact.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await artifact.text(), /hello\.txt/)
    const etag = artifact.headers.get('etag') as string
    const again = await get(`/${artifactPath(run.runId, ref.path)}`, { 'if-none-match': etag })
    assert.equal(again.status, 304)
  })

  test('traversal, encoded tricks and symlinks out of a run never reach a file', async () => {
    const runId = headers[0]?.runId as string
    await symlink(join(dir, 'reeval.config.ts'), join(source.historyDir, runId, 'escape.txt'))
    await symlink(
      join(dir, 'reeval.config.ts'),
      join(source.historyDir, '20990101T000000Z_abc1234_x_a1b2.json'),
    )
    for (const path of [
      `/data/runs/${runId}/escape.txt`,
      '/data/runs/20990101T000000Z_abc1234_x_a1b2.json',
      `/data/runs/${runId}/..%2F..%2F..%2Freeval.config.ts`,
      `/data/runs/${runId}/%2e%2e/%2e%2e/reeval.config.ts`,
      `/data/runs/${runId}/summary.md%00.txt`,
      `/data/runs/${runId}/..%5C..%5Creeval.config.ts`,
      '/data/runs/20260101T000000Z_0000000_nobody_a1b2.json',
      '/assets/../../reeval.config.ts',
      '/reeval.config.ts',
      '/data/unknown',
    ]) {
      const res = await get(path)
      assert.ok(res.status === 404 || res.status === 400, `${path} → ${res.status}`)
    }
  })

  test('a run directory that is a symlink serves nothing from its target', async () => {
    const runId = headers[0]?.runId as string
    const outside = await mkdtemp(join(tmpdir(), 'reeval-outside-'))
    writeFileSync(join(outside, 'summary.md'), 'outside the history folder')
    const [out, sibling] = ['20990102T000000Z_abc1234_x_a1b2', '20990103T000000Z_abc1234_x_a1b2']
    for (const [id, target] of [
      [out, outside],
      [sibling, join(source.historyDir, runId)],
    ] as const) {
      writeFileSync(join(source.historyDir, `${id}.json`), '{}')
      await symlink(target, join(source.historyDir, id), 'dir')
    }
    assert.equal((await get(`/${recordPath(out)}`)).status, 200)
    assert.equal((await get(`/${artifactPath(out, 'summary.md')}`)).status, 404)
    const ref = records.get(runId)?.evals[0]?.attempts[0]?.files.diff
    assert.ok(ref)
    assert.equal((await get(`/${artifactPath(runId, ref.path)}`)).status, 200)
    assert.equal((await get(`/${artifactPath(sibling, ref.path)}`)).status, 404)

    // Nor are its saved analyses, or notes under a symlinked `.reeval/analysis/<run>`.
    const saved = 'test/fixtures/records/before-proxy-egress/evals/.history'
    await cp(
      join(saved, '20261023T093806Z_66722ad_cursor-agent_e3gk', 'analysis'),
      join(outside, 'analysis'),
      { recursive: true },
    )
    mkdirSync(join(outside, 'notes'))
    const note: AnalysisNote = {
      kind: 'reeval-analysis-note',
      schemaVersion: 1,
      runId: out,
      evalId: 'e',
      harness: 'fake',
      model: 'fake',
      resolvedModel: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      attempts: ['fake#1'],
      text: 'A note.',
      usage: { inputTokens: null, outputTokens: null },
    }
    writeFileSync(join(outside, 'notes', 'e__fake.json'), JSON.stringify(note))
    mkdirSync(join(source.root, '.reeval/analysis'), { recursive: true })
    await symlink(outside, join(source.root, '.reeval/analysis', out), 'dir')
    const analysis = await (await get(`/${analysisDataPath(out)}`)).json()
    assert.deepEqual([analysis.entries, analysis.notes], [[], undefined])
  })

  test("serves an attempt's local debug data, and null where there is none", async () => {
    assert.equal((await (await get('/studio.json')).json()).features.debug, true)
    // The second run fails its judge, so its attempt kept a trace; the first passed.
    const [passed, failed] = [headers[0], headers[1]].map((h) => {
      const run = records.get(h?.runId as string) as RunRecord
      return { runId: run.runId, key: run.evals[0]?.attempts[0]?.key as string }
    }) as [{ runId: string; key: string }, { runId: string; key: string }]
    const view = async (runId: string, key: string) => {
      const res = await get(`/${debugApiPath(runId, key)}`)
      assert.equal(res.status, 200)
      return (await res.json()) as DebugView | null
    }
    const pass = (await view(passed.runId, passed.key)) as DebugView
    assert.deepEqual(
      [...new Set(pass.lines.map((l) => l.phase))],
      ['plan', 'env', 'image', 'container', 'harness', 'check', 'judge', 'teardown'],
    )
    assert.match(pass.lines[0]?.at ?? '', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    assert.deepEqual([pass.requests, pass.trace], [[], false])
    assert.equal((await get(`/${traceApiPath(passed.runId, passed.key)}`)).status, 404)

    const fail = (await view(failed.runId, failed.key)) as DebugView
    assert.equal(fail.trace, true)
    const trace = await get(`/${traceApiPath(failed.runId, failed.key)}`)
    assert.equal(trace.status, 200)
    assert.equal(trace.headers.get('content-security-policy'), 'sandbox')
    assert.match(await trace.text(), /^\{"kind":"trace",/)

    for (const [runId, key] of [
      [passed.runId, `${passed.key}0`],
      [passed.runId, 'evals/hello.eval.ts › greet › writes hello'],
      [passed.runId, '../../../reeval.config.ts # x#1'],
      ['not-a-run', passed.key],
    ]) {
      assert.equal(await view(runId as string, key as string), null, key)
    }

    // A debug folder that is a symlink to another run's isn't read through.
    const linked = '20990104T000000Z_abc1234_x_a1b2'
    await symlink(
      join(dir, '.reeval/debug', failed.runId),
      join(dir, '.reeval/debug', linked),
      'dir',
    )
    assert.equal(await view(linked, failed.key), null)
    assert.equal((await get(`/${traceApiPath(linked, failed.key)}`)).status, 404)
  })

  test("without the scratch source, unrecorded runs aren't served", async () => {
    const recordedOnly = createStudioApp({
      source: { ...source, scratch: false },
      app: fakeApp(),
      reeval: 'test',
      project: 'studio',
      token: null,
      hosts: [],
    })
    const url = `http://${HOST}/${recordPath(headers[3]?.runId as string)}`
    assert.equal((await recordedOnly.request(url)).status, 404)
    const manifest = await (await recordedOnly.request(`http://${HOST}/${manifestPath}`)).json()
    assert.equal(manifest.shards[0].runs, 3)
  })
})

const filesIn = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).replaceAll(sep, '/'))
    .sort()

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
      const app = createStudioApp({
        source: fresh,
        app: fakeApp(),
        reeval: 'test',
        project: 'studio',
        token: TOKEN,
        hosts: [HOST],
      })
      const res = await app.request(`http://${HOST}/${manifestPath}`, {
        headers: { host: HOST, cookie: `${COOKIE}=${TOKEN}` },
      })
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

describe('reeval studio build', () => {
  test('writes a static site with the same paths the server answers', async () => {
    assert.ok(existsSync(join(pkgRoot, 'dist/cli.js')), 'run pnpm build first')
    const out = join(dir, 'site')
    const r = await runCli(dir, ['studio', 'build', '--out', out, '--scratch'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /built site\/: 4 runs/)
    const written = filesIn(out)
    assert.ok(written.includes('index.html'))
    assert.ok(written.some((f) => /^assets\/.+\.js$/.test(f)))
    assert.ok(!written.some((f) => f.endsWith('escape.txt')), 'symlinks are never published')
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'assets are relative')
    const info = JSON.parse(readFileSync(join(out, 'studio.json'), 'utf8'))
    assert.equal(info.mode, 'static')
    assert.equal(info.features.artifacts, true)
    assert.equal(info.features.debug, false, 'local debug data is never published')
    assert.ok(existsSync(join(dir, '.reeval/debug')), 'twin: the project has debug data')
    assert.deepEqual(
      written.filter((f) => /debug\.log|trace\.ndjson|requests\.ndjson|^api\//.test(f)),
      [],
    )

    const app = createStudioApp({
      source: { ...source, historyDir: source.historyDir },
      app: new Map(),
      reeval: 'test',
      project: 'studio',
      token: null,
      hosts: [],
    })
    const urls = [manifestPath, ...new Set(headers.map((h) => shardPath(h.startedAt.slice(0, 7))))]
    for (const h of headers) {
      urls.push(recordPath(h.runId))
      const run = records.get(h.runId) as RunRecord
      for (const a of run.evals.flatMap((e) => e.attempts)) {
        const refs = [...Object.values(a.files), ...a.checks.flatMap((c) => (c.log ? [c.log] : []))]
        for (const ref of refs) urls.push(artifactPath(h.runId, ref.path))
      }
    }
    const compared = headers[2]?.runId as string
    const built = JSON.parse(readFileSync(join(out, recordPath(compared)), 'utf8')) as RunRecord
    assert.equal(built.evals[0]?.answers?.[0]?.question, 'Which wrote hello.txt?')
    assert.deepEqual(built.evals[0]?.answers, records.get(compared)?.evals[0]?.answers)
    for (const url of urls) {
      assert.ok(written.includes(url), `${url} is in the build`)
      const served = await (await app.request(`http://x/${url}`)).text()
      const built = readFileSync(join(out, url), 'utf8')
      if (url === manifestPath) {
        const strip = (s: string) => JSON.stringify({ ...JSON.parse(s), generatedAt: null })
        assert.equal(strip(built), strip(served), url)
      } else {
        assert.equal(built, served, url)
      }
    }
  })

  test("a run's notes are in the build as the server serves them; a cached summary only live", async () => {
    const p = await project('studio-notes', {
      'reeval.config.ts': fakeConfig({
        extra: `analysis: { insights: false, model: fakeAnalysis({ output: { tldr: 'A summary.', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'x' } } }) },`,
      }).replace(
        "import { fakeJudge } from 'reeval/judge'",
        "import { fakeAnalysis, fakeJudge } from 'reeval/judge'",
      ),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes', async (c) => {
  await c.send('Write it')
  expect(1).toBe(1)
})
`,
    })
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const [runId] = readdirSync(join(p.dir, '.reeval/runs')).filter((n) => !n.endsWith('.json'))
    const notes = join(p.dir, '.reeval/analysis', runId as string, 'notes')
    mkdirSync(notes, { recursive: true })
    const note: AnalysisNote = {
      kind: 'reeval-analysis-note',
      schemaVersion: 1,
      runId: runId as string,
      evalId: 'evals/a.eval.ts › writes',
      harness: 'fake',
      model: 'fake',
      resolvedModel: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      attempts: ['fake#1'],
      text: 'A note.',
      usage: { inputTokens: null, outputTokens: null },
    }
    writeFileSync(join(notes, 'writes__fake.json'), JSON.stringify(note))
    const analyzed = await runCli(p.dir, ['analyze', 'latest', '--vs', 'none'])
    assert.equal(analyzed.code, 0, analyzed.stdout + analyzed.stderr)
    const out = join(p.dir, 'site')
    assert.equal((await runCli(p.dir, ['studio', 'build', '--out', out, '--scratch'])).code, 0)
    const built = JSON.parse(readFileSync(join(out, analysisDataPath(runId as string)), 'utf8'))
    assert.deepEqual(
      [built.entries, built.notes.map((n: { text: string }) => n.text)],
      [[], ['A note.']],
    )
    const app = createStudioApp({
      source: { root: p.dir, historyDir: join(p.dir, 'evals/.history'), scratch: true },
      app: new Map(),
      reeval: 'test',
      project: 'studio',
      token: null,
      hosts: [],
    })
    const served = await (await app.request(`http://x/${analysisDataPath(runId as string)}`)).json()
    assert.deepEqual(served.notes, built.notes)
    assert.deepEqual(
      served.entries.map((e: { source: string; doc: { analysis: { tldr: string } } }) => [
        e.source,
        e.doc.analysis.tldr,
      ]),
      [['cached', 'A summary.']],
    )
  })

  test('--no-artifacts writes records and the index only; a non-studio folder is refused', async () => {
    const out = join(dir, 'site-lean')
    const r = await runCli(dir, ['studio', 'build', '--out', out, '--no-artifacts'])
    assert.equal(r.code, 0, r.stderr)
    const runs = filesIn(join(out, 'data')).filter((f) => f.startsWith('runs/'))
    assert.deepEqual(
      runs,
      headers.filter((h) => h.recorded).map((h) => `runs/${h.runId}.json`),
    )
    assert.equal(
      JSON.parse(readFileSync(join(out, 'studio.json'), 'utf8')).features.artifacts,
      false,
    )

    const refused = await runCli(dir, ['studio', 'build', '--out', 'evals'])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /isn't empty and isn't a previous studio build/)
  })

  test('reeval studio prints a tokenised 127.0.0.1 URL and serves the app', async () => {
    const child = spawn(
      process.execPath,
      [join(pkgRoot, 'dist/cli.js'), 'studio', '--port', '47311'],
      { cwd: dir, env: baseEnv },
    )
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (d) => {
          out += d
          const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(out)
          if (m) resolve(m[0])
        })
        child.on('exit', () => reject(new Error(out)))
      })
      const redirect = await fetch(url, { redirect: 'manual' })
      assert.equal(redirect.status, 302)
      const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0] as string
      const page = await fetch(new URL('/', url), { headers: { cookie } })
      assert.equal(page.status, 200)
      assert.match(await page.text(), /<div id="root">/)
      assert.equal((await fetch(new URL('/', url))).status, 401)
    } finally {
      child.kill('SIGINT')
    }
  })
})
