// Eval, group and todo names that hold a secret: masked wherever reeval writes or prints them,
// and two that mask to the same name refused at plan time. The fixture
// `secrets/masked-eval-names` checks a family case's name from a run.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

/** Made-up keys in Anthropic's shape, one per letter. */
const key = (c: string) => `sk-ant-${c.repeat(24)}`
const KEYS = /sk-ant-|aaaaaaaaaa|bbbbbbbbbb|cccccccccc|dddddddddd/

/** Every file under `dir`, with its path, read as text. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).flatMap((p) => {
    const path = join(dir, p)
    return statSync(path).isFile() ? [`${path}\n${readFileSync(path, 'utf8')}`] : []
  })

const evalFile = `
import { evaluate, expect, group } from 'reeval'
const key = (c: string) => 'sk-ant-' + c.repeat(24)
evaluate('plain ' + key('a'), async () => { expect(1).toBe(1) })
group('grp ' + key('d'), () => {
  evaluate.each([{ k: key('b') }])('case [$k]', async () => { expect(1).toBe(2) })
  evaluate.todo('later ' + key('c'))
})
`

describe('eval names that hold a secret', () => {
  test('are masked in the record, its files, the terminal and every view', async () => {
    const p = await project('masked-names', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': evalFile,
    })
    const runs: string[] = []
    for (const _ of [1, 2]) {
      const run = await runCli(p.dir, ['run', '--record'])
      assert.equal(run.code, 1, run.stdout + run.stderr)
      runs.push(run.stdout + run.stderr)
    }
    const { run } = readRun(p.dir)
    assert.deepEqual(run.evals.map((e) => e.id).sort(), [
      'evals/a.eval.ts › grp [REDACTED] › case [[REDACTED]]',
      'evals/a.eval.ts › grp [REDACTED] › later [REDACTED]',
      'evals/a.eval.ts › plain [REDACTED]',
    ])
    const views: string[] = []
    for (const args of [
      ['run', '--dry-run'],
      ['show'],
      ['history'],
      ['compare'],
      ['query', 'select eval_key, key from attempts'],
      ['query', 'failing_attempts'],
      ['studio', 'build', '--out', join(p.dir, 'site')],
    ]) {
      const out = await runCli(p.dir, args)
      assert.ok(out.code === 0 || out.code === 1, `${args.join(' ')}: ${out.stdout}${out.stderr}`)
      views.push(`reeval ${args.join(' ')}\n${out.stdout}${out.stderr}`)
    }
    assert.match(views[1] ?? '', /plain \[REDACTED\]/)
    const written = ['.reeval', 'evals/.history', 'site'].flatMap((d) => filesUnder(join(p.dir, d)))
    for (const text of [...runs, ...views, ...written]) {
      assert.doesNotMatch(text, KEYS, text.slice(0, 2000))
    }
  })

  test('two that mask to the same name are refused at plan time, naming neither key', async () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        'two evals',
        `evaluate('e ' + key('a'), async () => {})\nevaluate('e ' + key('b'), async () => {})`,
        /evaluate\("e \[REDACTED\]"\) names a secret, and its masked name is another eval's in this file: name it without the secret\./,
      ],
      [
        "an evaluate.each's cases",
        `evaluate.each([{ k: key('a') }, { k: key('b') }])('e [$k]', async () => {})`,
        /evaluate\("e \[\[REDACTED\]\]"\) names a secret, .* For evaluate\.each, name each case by %# or by a field that holds no secret\./,
      ],
      [
        'two groups',
        `group('g ' + key('a'), () => {})\ngroup('g ' + key('b'), () => {})`,
        /group\("g \[REDACTED\]"\) names a secret, and its masked name is another group's in this file/,
      ],
      [
        'two todos',
        `evaluate.todo('t ' + key('a'))\nevaluate.todo('t ' + key('b'))`,
        /evaluate\.todo\("t \[REDACTED\]"\) names a secret/,
      ],
    ]
    for (const [what, body, message] of cases) {
      const p = await project('masked-collide', {
        'reeval.config.ts': fakeConfig(),
        'evals/a.eval.ts': `import { evaluate, group } from 'reeval'\nconst key = (c: string) => 'sk-ant-' + c.repeat(24)\n${body}\n`,
      })
      const run = await runCli(p.dir, ['run', '--dry-run'])
      const out = run.stdout + run.stderr
      assert.equal(run.code, 2, `${what}: ${out}`)
      assert.match(out, message, what)
      assert.doesNotMatch(out, KEYS, what)
    }
  })

  test('twin: the same secret name twice in a group, and a repeated group, still plan', async () => {
    const p = await project('masked-same', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate, group } from 'reeval'
const k = 'sk-ant-' + 'a'.repeat(24)
group('g ' + k, () => { evaluate('one', async () => {}) })
group('g ' + k, () => { evaluate('two', async () => {}) })
`,
    })
    const run = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /g \[REDACTED\] › one/)
    assert.match(run.stdout, /g \[REDACTED\] › two/)
  })
})
