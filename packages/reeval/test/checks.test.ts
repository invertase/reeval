// Named check results: every `expect` an attempt makes lands in its record, each cell tallies
// them, and a compare says which checks told the variant from its control and which can't.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

type Row = Record<string, unknown>

async function query(dir: string, sql: string): Promise<Row[]> {
  const r = await runCli(dir, ['query', sql, '--json'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout) as Row[]
}

// Both arms write ok.txt; only the variant writes styled.txt.
const compareProject = (name: string) =>
  project(name, {
    'reeval.config.ts': fakeConfig({
      harness:
        "{ files: { 'ok.txt': 'y' }, withSkill: { files: { 'ok.txt': 'y', 'styled.txt': 'Ahoy' } } }",
    }),
    'skills/house/SKILL.md': '---\nname: house\ndescription: The house style.\n---\nAhoy.\n',
    'evals/s.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const styled = defineEnvironment('styled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/house')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [styled] }, runs: 2 }, async (c) => {
  await c.send('go')
  await expect.soft(c, 'writes ok.txt').toHaveFile('ok.txt')
  await expect(c, 'house style').toHaveFile('styled.txt', /Ahoy/)
  await expect(c.exec('test -f ok.txt')).toSucceed()
})
`,
  })

describe('named check results', () => {
  test("a compare tallies each check per side and flags the ones that don't discriminate", async () => {
    const p = await compareProject('checks-compare')
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^ +checks: house style 2\/2 vs 0\/2 · toSucceed test -f ok\.txt 2\/2 vs 0\/2 \(2 not run\) · writes ok\.txt 2\/2 vs 2\/2 \(doesn't discriminate\)$/m,
    )
    assert.match(
      r.stdout,
      /^Checks that don't discriminate \(1\)\n · evals\/s\.eval\.ts › greets {2}fake\/styled\/fake {2}writes ok\.txt: passes on both$/m,
    )

    const { run, read } = readRun(p.dir)
    const entry = run.evals[0]
    const control = entry?.attempts.find((a) => a.cell === 'fake/plain/fake')
    assert.deepEqual(
      control?.assertions?.map((x) => [x.label, x.labelled, x.matcher, x.status, x.soft]),
      [
        ['writes ok.txt', true, 'toHaveFile', 'pass', true],
        ['house style', true, 'toHaveFile', 'fail', false],
      ],
      'the control stops at its hard failure',
    )
    assert.match(
      control?.assertions?.[1]?.message ?? '',
      /^house style: expected file styled\.txt to exist/,
    )
    const variant = entry?.cells.find((c) => c.role === 'variant')
    assert.deepEqual(
      variant?.checks?.map((k) => [k.label, k.pass, k.control?.pass, k.control?.notRun, k.verdict]),
      [
        ['writes ok.txt', 2, 2, 0, 'both-pass'],
        ['house style', 2, 0, 0, 'discriminates'],
        ['toSucceed test -f ok.txt', 2, 0, 2, 'discriminates'],
      ],
    )
    assert.equal(
      entry?.cells.find((c) => c.role === 'control')?.checks?.[0]?.verdict,
      undefined,
      'the control has tallies, not verdicts',
    )
    assert.match(read('summary.md'), /checks house style 2\/2 vs 0\/2 · /)

    assert.deepEqual(
      await query(
        p.dir,
        'SELECT label, variant_pass, control_pass, control_not_run, verdict FROM check_discrimination ORDER BY label',
      ),
      [
        {
          label: 'house style',
          variant_pass: 2,
          control_pass: 0,
          control_not_run: 0,
          verdict: 'discriminates',
        },
        {
          label: 'toSucceed test -f ok.txt',
          variant_pass: 2,
          control_pass: 0,
          control_not_run: 2,
          verdict: 'discriminates',
        },
        {
          label: 'writes ok.txt',
          variant_pass: 2,
          control_pass: 2,
          control_not_run: 0,
          verdict: 'both-pass',
        },
      ],
    )
    const failing = await query(p.dir, 'SELECT DISTINCT first_failed_check FROM failing_attempts')
    assert.deepEqual(failing, [{ first_failed_check: 'house style' }])
    const counts = await query(
      p.dir,
      'SELECT status, soft, COUNT(*) AS n FROM assertions GROUP BY status, soft ORDER BY status, soft',
    )
    assert.deepEqual(counts, [
      { status: 'fail', soft: 0, n: 2 },
      { status: 'pass', soft: 0, n: 4 },
      { status: 'pass', soft: 1, n: 4 },
    ])

    const agent = await runCli(p.dir, ['run'], { env: { REEVAL_UI: 'agent' } })
    assert.match(
      agent.stdout,
      /^check doesn't discriminate: evals\/s\.eval\.ts › greets {2}fake\/styled\/fake {2}writes ok\.txt: passes on both$/m,
    )
  })

  test('without a compare the attempts record their assertions and the summary has no checks line', async () => {
    const p = await project('checks-single', {
      'reeval.config.ts': fakeConfig({ harness: "{ files: { 'ok.txt': 'y' } }" }),
      'evals/a.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes', { runs: 2 }, async (c) => {
  await c.send('go')
  for (const name of ['ok.txt', 'ok.txt']) await expect(c).toHaveFile(name)
  expect(await c.judge('Is it ok?')).toPass()
})
`,
    })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /checks:|Checks that don't discriminate/)
    assert.match(
      r.stdout,
      /assert ✓ toHaveFile ok\.txt #2 \(toHaveFile, pass\)/,
      '-v shows each one',
    )
    const { run } = readRun(p.dir)
    assert.deepEqual(
      run.evals[0]?.attempts[0]?.assertions?.map((x) => x.label),
      ['toHaveFile ok.txt', 'toHaveFile ok.txt #2', 'toPass Is it ok?'],
    )
    assert.deepEqual(
      run.evals[0]?.cells[0]?.checks?.map((k) => [k.label, k.pass, k.verdict]),
      [
        ['toHaveFile ok.txt', 2, undefined],
        ['toHaveFile ok.txt #2', 2, undefined],
        ['toPass Is it ok?', 2, undefined],
      ],
    )
  })
})
