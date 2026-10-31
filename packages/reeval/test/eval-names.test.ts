// Eval, group and todo names that hold a secret: masked wherever reeval writes or prints them,
// and two that mask to the same name refused at plan time. The fixture
// `secrets/masked-eval-names` checks a family case's name from a run.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

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
  evaluate('case', { cases: [{ id: key('b') }] }, async () => { expect(1).toBe(2) })
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
        "an eval's cases",
        `evaluate('e', { cases: [{ id: key('a') }, { id: key('b') }] }, async () => {})`,
        /evaluate\("e \[\[REDACTED\]\]"\) names a secret, .* Give each case a key that holds no secret\./,
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
      [
        'an eval and a todo',
        `evaluate('t ' + key('a'), async () => {})\nevaluate.todo('t ' + key('b'))`,
        /evaluate\.todo\("t \[REDACTED\]"\) names a secret, and its masked name is another eval's/,
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

  test("a name masked by a variable's value has a plan note naming the variable", async () => {
    const p = await project('masked-by-env', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('migrates the pgfixture9 schema', async () => {})
`,
    })
    const env = { FIXTURE_DB_PASSWORD: 'pgfixture9' }
    const run = await runCli(p.dir, ['run', '--dry-run'], { env })
    const out = run.stdout + run.stderr
    assert.equal(run.code, 0, out)
    assert.match(out, /migrates the \[REDACTED\] schema/)
    assert.match(out, /name masked: it holds the value of FIXTURE_DB_PASSWORD, so its id differs/)
    assert.doesNotMatch(out, /pgfixture9/)
    // Twin: without the variable, the name is as written and there's no note.
    const plain = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(plain.code, 0, plain.stdout + plain.stderr)
    assert.match(plain.stdout, /migrates the pgfixture9 schema/)
    assert.doesNotMatch(plain.stdout, /name masked/)
  })

  test('a filter that holds a secret says names are masked; the masked name matches', async () => {
    const p = await project('masked-filter', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('plain sk-ant-' + 'a'.repeat(24), async () => {})
`,
    })
    const refused = await runCli(p.dir, ['run', '--dry-run', `plain sk-ant-${'a'.repeat(24)}`])
    const out = refused.stdout + refused.stderr
    assert.equal(refused.code, 2, out)
    assert.match(
      out,
      /Eval names are masked, so a filter that holds a secret can't match one: filter by the masked name \("plain \[REDACTED\]"\)/,
    )
    assert.doesNotMatch(out, KEYS)
    const matched = await runCli(p.dir, ['run', '--dry-run', 'plain [REDACTED]'])
    assert.equal(matched.code, 0, matched.stdout + matched.stderr)
    assert.match(matched.stdout, /plain \[REDACTED\]/)
  })

  test('a value declared with secret() in a name is refused at plan time, writing it nowhere', async () => {
    // DB_PASS isn't a secret-looking variable name and the value has no credential shape, so
    // only the environment's secret.fromEnv makes it a secret.
    const value = 'hunter9hunter9xq'
    const file = (name: string) => `import { defineEnvironment, evaluate } from 'reeval'
const db = defineEnvironment('db', ({ secret }) => ({ env: { DB_PASS: secret.fromEnv('DB_PASS') } }))
evaluate(${JSON.stringify(name)}, { environments: db }, async () => {})
evaluate.todo('later ' + ${JSON.stringify(value)})
`
    const p = await project('masked-declared', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': file(`uses ${value}`),
    })
    const env = { DB_PASS: value }
    for (const args of [['run', '--dry-run'], ['run']]) {
      const run = await runCli(p.dir, args, { env })
      const out = run.stdout + run.stderr
      assert.equal(run.code, 2, `${args.join(' ')}: ${out}`)
      assert.match(
        out,
        /evals\/a\.eval\.ts › uses \[REDACTED\] names a secret declared with secret\(\): name it without the secret\./,
      )
      assert.doesNotMatch(out, /hunter9/)
    }
    const reeval = join(p.dir, '.reeval')
    for (const text of existsSync(reeval) ? filesUnder(reeval) : []) {
      assert.doesNotMatch(text, /hunter9/)
    }
    // Twin: named without the value, the same eval plans; the todo is refused on its own.
    const twin = await project('masked-declared-twin', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': file('uses the db').replace(/evaluate\.todo.*\n/, ''),
    })
    const planned = await runCli(twin.dir, ['run', '--dry-run'], { env })
    assert.equal(planned.code, 0, planned.stdout + planned.stderr)
    const todo = await project('masked-declared-todo', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': file('uses the db'),
    })
    const refused = await runCli(todo.dir, ['run', '--dry-run'], { env })
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /evals\/a\.eval\.ts › later \[REDACTED\] names a secret/)
  })

  test("a case key that holds a secret is masked in the case's name, the notes and where's exclusions", async () => {
    const value = 'abcd1234efgh5678ijkl'
    const p = await project('masked-case-key', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const a = defineEnvironment('a-env', { traits: { stack: 'a' } })
const b = defineEnvironment('b-env', { traits: { stack: 'b' } })
evaluate('keys', {
  environments: [a, b],
  cases: [{ id: 'k ${value}', stack: 'a' }, { id: 'plain', stack: 'b' }],
  where: ({ case: c, environment }) => environment.traits.stack === c.stack,
}, async () => {})
`,
    })
    const env = { MY_API_TOKEN: value }
    const dry = await runCli(p.dir, ['run', '--dry-run', '--json'], { env })
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /name masked: it holds the value of MY_API_TOKEN/)
    const run = await runCli(p.dir, ['run', '--record'], { env })
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const { run: record } = readRun(p.dir)
    assert.deepEqual(record.evals.map((e) => e.id).sort(), [
      'evals/a.eval.ts › keys [k [REDACTED]]',
      'evals/a.eval.ts › keys [plain]',
    ])
    const excluded = (record.families ?? []).flatMap((f) => f.excluded ?? []).map((e) => e.case)
    assert.deepEqual(excluded.sort(), ['k [REDACTED]', 'plain'])
    const written = ['.reeval', 'evals/.history'].flatMap((d) => filesUnder(join(p.dir, d)))
    for (const text of [dry.stdout, dry.stderr, run.stdout, run.stderr, ...written]) {
      assert.doesNotMatch(text, /abcd1234|efgh5678/, text.slice(0, 2000))
    }
  })

  test('a case key that holds a value declared with secret() is refused at plan time', async () => {
    const value = 'hunter9hunter9xq'
    const p = await project('masked-case-declared', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const db = defineEnvironment('db', ({ secret }) => ({ env: { DB_PASS: secret.fromEnv('DB_PASS') } }))
evaluate('uses', { environments: db, cases: ['${value}', 'plain'] }, async () => {})
`,
    })
    const run = await runCli(p.dir, ['run'], { env: { DB_PASS: value } })
    const out = run.stdout + run.stderr
    assert.equal(run.code, 2, out)
    assert.match(
      out,
      /evals\/a\.eval\.ts › uses \[\[REDACTED\]\] names a secret declared with secret\(\)/,
    )
    assert.doesNotMatch(out, /hunter9/)
    const reeval = join(p.dir, '.reeval')
    for (const text of existsSync(reeval) ? filesUnder(reeval) : []) {
      assert.doesNotMatch(text, /hunter9/)
    }
  })
})
