// `reeval override`: a person's verdict on one judgement, in the run's overrides.json beside a record
// that never changes. show, show --md, query, analyze's digest and reeval record read it; the
// attempt's outcome and the cell's pass rate stay the judge's. The numbers are Ben's new-skill arm:
// email sign-in judged 0.98, 0.09 and 0.97, the 0.09 a false negative by his reading of the diff.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { AttemptRecord, EvalEntry } from '../src/history/types.ts'
import { cellJudgeRates, effectiveVerdict, judgeRatesLabel } from '../src/view/judgements.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

const QUESTION = 'Does the app offer email sign-in?'
const REASON = 'mounts SignInAuthScreen, which renders the email form'

async function signInProject() {
  return project('override', {
    'reeval.config.ts': fakeConfig({ harness: "{ withSkill: { text: 'skilled' } }" }),
    'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
    'evals/sign-in.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const none = defineEnvironment('no-skill', { sandbox })
const skilled = defineEnvironment('new-skill', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
const newSkill = [0.98, 0.09, 0.97]
const model = fakeJudge({ score: (s) => (s.output === 'skilled' ? (newSkill.shift() ?? 0.98) : 0.96) })
evaluate('sign-in', { compare: { baseline: none, variants: [skilled] }, runs: 3 }, async (c) => {
  await c.send('Build sign-in')
  expect.soft(await c.judge(${JSON.stringify(QUESTION)}, { model }), 'Email sign-in').toPass()
})
`,
  })
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Runs the evals; one new-skill attempt fails its judge, so the run exits 1. */
async function runEvals(dir: string) {
  const r = await runCli(dir, ['run', '--concurrency', '1'])
  assert.equal(r.code, 1, r.stdout + r.stderr)
}

async function cli(dir: string, args: string[]) {
  const r = await runCli(dir, args)
  assert.equal(r.code, 0, `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`)
  return r.stdout
}

describe('reeval override', () => {
  test("a person's verdict stands beside the judge's everywhere, and the record is unchanged", async () => {
    const p = await signInProject()
    await runEvals(p.dir)
    const { run } = readRun(p.dir)
    const failed = run.evals[0]?.attempts.find((a) => a.judgements[0]?.verdict === 'fail')
    assert.ok(failed, 'one new-skill attempt failed the judge')
    assert.equal(failed.judgements[0]?.score, 0.09)
    const recordPath = join(p.dir, '.reeval/runs', `${run.runId}.json`)
    const before = sha(recordPath)
    assert.match(
      await cli(p.dir, ['query', 'SELECT COUNT(*) AS n FROM judgements WHERE overridden = 1']),
      /\b0\b/,
      'nothing overridden yet, and the database is now built',
    )

    const out = await cli(p.dir, [
      'override',
      'latest',
      `sign-in # ${failed.id}`,
      'Email sign-in',
      '--verdict',
      'pass',
      '--reason',
      REASON,
      '--author',
      'ben',
    ])
    assert.match(
      out,
      new RegExp(
        `sign-in # ${failed.id} · Email sign-in: judge fail 0\\.09 \\(≥ 0\\.8\\), overridden pass by ben`,
      ),
    )
    assert.match(out, /reeval record copies it with the run/)
    assert.equal(sha(recordPath), before, 'the record file is never rewritten')
    const file = JSON.parse(
      readFileSync(join(p.dir, '.reeval/runs', run.runId, 'overrides.json'), 'utf8'),
    )
    assert.equal(file.kind, 'reeval-overrides')
    assert.deepEqual(
      file.overrides.map((o: Record<string, unknown>) => [o.attempt, o.label, o.verdict, o.author]),
      [[failed.key, 'Email sign-in', 'pass', 'ben']],
    )

    const show = await cli(p.dir, ['show'])
    assert.match(
      show,
      /judge fail 0\.09 \(≥ 0\.8\) {2}Email sign-in: Does the app offer email sign-in\?/,
    )
    assert.match(show, new RegExp(`\\n\\s+overridden pass by ben: ${REASON}`))
    const md = await cli(p.dir, ['show', '--md'])
    assert.match(md, new RegExp(`  - Overridden \\*\\*pass\\*\\* by ben: ${REASON}`))
    assert.match(
      md,
      /checks Email sign-in 2\/3 vs 3\/3 \(3\/3 with 1 override\)/,
      'the cell rate shows both',
    )
    assert.match(show, /checks Email sign-in 2\/3 vs 3\/3 \(3\/3 with 1 override\)/)
    const json = JSON.parse(await cli(p.dir, ['show', '--json']))
    const shown = json.evals[0].attempts.find((a: { key: string }) => a.key === failed.key)
    assert.equal(shown.judgements[0].verdict, 'fail', "the judge's verdict is kept")
    assert.equal(shown.judgements[0].override.verdict, 'pass')
    assert.equal(shown.outcome, failed.outcome, "the attempt's outcome is the judge's")

    const rows = JSON.parse(
      await cli(p.dir, [
        'query',
        'SELECT verdict, score, overridden, override_verdict, override_author, override_reason FROM judgements WHERE overridden = 1',
        '--json',
      ]),
    )
    assert.deepEqual(rows, [
      {
        verdict: 'fail',
        score: 0.09,
        overridden: 1,
        override_verdict: 'pass',
        override_author: 'ben',
        override_reason: REASON,
      },
    ])

    const context = await cli(p.dir, ['analyze', '--context'])
    const digest = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(context)?.[1] ?? '{}')
    const judge = digest.facts.find((f: { kind: string }) => f.kind === 'judge')
    assert.equal(judge.overridden, 1)
    assert.deepEqual(
      judge.overrides.map((o: Record<string, unknown>) => [o.label, o.judge, o.verdict, o.by]),
      [['Email sign-in', 'fail 0.09', 'pass', 'ben']],
    )
    const criteria = digest.facts.find((f: { kind: string }) => f.kind === 'criteria')
    assert.deepEqual(criteria.rows, [
      {
        label: 'Email sign-in',
        cells: {
          'no-skill (control)': '3/3 · 0.96',
          'new-skill': '2/3 · 0.68 (3/3 with 1 override)',
        },
      },
    ])
    const attempt = Object.values(digest.attempts).find(
      (a) => (a as { key: string }).key === failed.key,
    ) as Record<string, unknown>
    assert.deepEqual(attempt.overrides, { 'Email sign-in': 'pass' })
    const failure = digest.facts.find((f: { kind: string }) => f.kind === 'failure')
    assert.ok(!failure?.judges, 'an overridden verdict is not cited as a failure')
    assert.ok(
      digest.evidence.every((e: { lines: string[] }) => !e.lines.some((l) => l.includes('0.09'))),
      "the overridden judge isn't failing evidence",
    )

    await cli(p.dir, ['record', '--artifacts', 'none'])
    const recorded = join(p.dir, 'evals/.history', run.runId, 'overrides.json')
    assert.ok(existsSync(recorded), 'reeval record copies overrides.json with the run')
    const again = await cli(p.dir, [
      'override',
      'latest',
      failed.key,
      'email',
      '--verdict',
      'fail',
      '--reason',
      'rechecked: the email form never renders',
      '--author',
      'ana',
    ])
    assert.match(again, /overridden fail by ana, replacing ben's pass/)
    assert.match(again, /Commit it with git\./)
    const replaced = JSON.parse(readFileSync(recorded, 'utf8'))
    assert.deepEqual(
      replaced.overrides.map((o: Record<string, unknown>) => [o.verdict, o.author]),
      [['fail', 'ana']],
      'one override per judgement: the newest replaces it',
    )
    assert.match(
      await cli(p.dir, ['query', 'SELECT override_author FROM judgements WHERE overridden = 1']),
      /ana/,
      'query re-reads a run whose overrides.json changed',
    )
  })

  test('canary: no reason, a bad verdict or an ambiguous attempt write nothing', async () => {
    const p = await signInProject()
    await runEvals(p.dir)
    const { run } = readRun(p.dir)
    const attempt = run.evals[0]?.attempts[0]
    assert.ok(attempt)
    const tries: Array<[string[], RegExp]> = [
      [
        ['override', 'latest', attempt.key, 'Email sign-in', '--verdict', 'pass'],
        /--reason is required/,
      ],
      [
        ['override', 'latest', attempt.key, 'Email sign-in', '--verdict', 'ok', '--reason', 'x'],
        /--verdict must be pass or fail/,
      ],
      [
        ['override', 'latest', 'sign-in', 'Email sign-in', '--verdict', 'pass', '--reason', 'x'],
        /"sign-in" matches 6 judged attempts; say which:\n {2}sign-in # fake\/no-skill\/fake#1\n/,
      ],
      [
        ['override', 'latest', attempt.key, 'checkout', '--verdict', 'pass', '--reason', 'x'],
        /No judge of sign-in # .+ matches "checkout"; the run has:\n {2}Email sign-in/,
      ],
    ]
    for (const [args, message] of tries) {
      const r = await runCli(p.dir, args)
      assert.notEqual(r.code, 0, args.join(' '))
      assert.match(r.stderr + r.stdout, message)
    }
    assert.ok(!existsSync(join(p.dir, '.reeval/runs', run.runId, 'overrides.json')))
  })

  test('an unreadable overrides.json is ignored with a warning, never a crash', async () => {
    const p = await signInProject()
    await runEvals(p.dir)
    const { run, dir } = readRun(p.dir)
    writeFileSync(join(dir, 'overrides.json'), '{ not json')
    const r = await runCli(p.dir, ['show'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stderr,
      new RegExp(`warning: ignored .*${run.runId}/overrides\\.json: unreadable`),
    )
    assert.doesNotMatch(r.stdout, /overridden/)
  })

  test("an unlabelled judge's rate names its overrides, both ways; canary: none without", () => {
    const judged = (verdict: 'pass' | 'fail', override?: 'pass' | 'fail') =>
      ({
        cell: 'new-skill',
        outcome: verdict,
        assertions: [],
        judgements: [
          {
            key: '0:abc',
            question: 'Email sign-in?',
            verdict,
            score: verdict === 'pass' ? 0.98 : 0.09,
            threshold: 0.8,
            model: 'typesafe-ai/jev-1.13.0',
            ...(override
              ? { override: { verdict: override, reason: 'r', author: 'ben', at: '' } }
              : {}),
          },
        ],
      }) as unknown as AttemptRecord
    const e = (attempts: AttemptRecord[]) =>
      ({ attempts, cells: [{ key: 'new-skill', role: 'variant' }] }) as unknown as EvalEntry
    const ben = e([judged('pass'), judged('fail', 'pass'), judged('pass')])
    assert.equal(
      judgeRatesLabel(cellJudgeRates(ben, 'new-skill')),
      'Email sign-in 2/3 (3/3 with 1 override)',
    )
    const down = e([judged('pass', 'fail'), judged('pass', 'fail'), judged('pass')])
    assert.equal(
      judgeRatesLabel(cellJudgeRates(down, 'new-skill')),
      'Email sign-in 3/3 (1/3 with 2 overrides)',
    )
    assert.equal(
      judgeRatesLabel(cellJudgeRates(e([judged('pass'), judged('fail')]), 'new-skill')),
      'Email sign-in 1/2',
    )
    assert.equal(effectiveVerdict({ verdict: 'fail' }), 'fail')
  })
})
