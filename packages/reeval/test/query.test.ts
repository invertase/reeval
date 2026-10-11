// `reeval query` over `.reeval/history.db`: a projection of the run records, so
// every check compares a query with what the records say.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { nodeAtLeast, SQLITE_NODE } from '../src/history/db.ts'
import { statementCount } from '../src/query.ts'
import { baseEnv, fakeConfig, pkgRoot, project, readRun, runCli } from './helpers.ts'

type Row = Record<string, unknown>

async function query(dir: string, sql: string, env?: NodeJS.ProcessEnv): Promise<Row[]> {
  const r = await runCli(dir, ['query', sql, '--json'], env ? { env } : {})
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout) as Row[]
}

const one = async (dir: string, sql: string) => (await query(dir, sql))[0] ?? {}

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill. Use when testing.\n---\nBody.\n`

describe('reeval query', () => {
  test('the projection matches the record, and the views answer from it', async () => {
    const p = await project('query-basics', {
      'reeval.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'skills/house-greeting/SKILL.md': skill('house-greeting'),
      'evals/s.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/house-greeting')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [skilled] }, runs: 3 }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const { run } = readRun(p.dir)
    assert.equal(existsSync(join(p.dir, '.reeval/history.db')), false, 'reeval run leaves it alone')

    const counts = await one(
      p.dir,
      `SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM evals) AS evals,
        (SELECT COUNT(*) FROM cells) AS cells, (SELECT COUNT(*) FROM attempts) AS attempts`,
    )
    assert.deepEqual(counts, { runs: 1, evals: 1, cells: 2, attempts: 6 })
    assert.ok(existsSync(join(p.dir, '.reeval/history.db')), 'reeval query builds it in .reeval/')

    const variant = run.evals[0]?.cells.find((c) => c.role === 'variant')
    const [lift] = await query(p.dir, 'lift')
    assert.deepEqual(
      [lift?.run_id, lift?.variant, lift?.variant_pass, lift?.control_pass, lift?.points],
      [run.runId, 'skilled', 3, 0, variant?.lift?.points],
    )
    assert.deepEqual([lift?.lo, lift?.hi], [variant?.lift?.interval.lo, variant?.lift?.interval.hi])

    const failing = await query(p.dir, 'SELECT * FROM failing_attempts')
    assert.equal(failing.length, 3, 'the control fails its three attempts')
    assert.ok(failing.every((f) => f.cell_key === 'fake/plain/fake' && f.skill === null))

    const trend = await query(p.dir, 'eval_trend')
    assert.deepEqual(
      trend.map((t) => [t.eval_key, t.outcome, t.recorded]),
      [['evals/s.eval.ts › greets', 'pass', 0]],
    )

    const text = await runCli(p.dir, ['query', 'SELECT key, outcome FROM evals'])
    assert.equal(text.code, 0, text.stderr)
    assert.equal(text.stdout, 'key                       outcome\nevals/s.eval.ts › greets  pass\n')
    assert.match(text.stderr, /history\.db: 1 runs/)
  })

  test('with no statement it lists the views, tables and examples; --schema lists columns', async () => {
    const p = await project('query-schema', { 'reeval.config.ts': fakeConfig() })
    const r = await runCli(p.dir, ['query'])
    assert.equal(r.code, 0, r.stderr)
    for (const view of [
      'lift',
      'flaky_cells',
      'drift',
      'failing_attempts',
      'eval_trend',
      'verdict_flips',
    ]) {
      assert.match(r.stdout, new RegExp(`^  ${view}\\(`, 'm'))
    }
    assert.match(r.stdout, /^Examples:\n {2}reeval query lift$/m)
    const schema = await runCli(p.dir, ['query', '--schema', '--json'])
    const objects = JSON.parse(schema.stdout) as Array<{ name: string; columns: string[] }>
    assert.ok(objects.find((o) => o.name === 'cells')?.columns.includes('environment_digest'))
  })

  test('it syncs incrementally; a recorded run wins over its scratch copy; deleted runs drop', async () => {
    const p = await project('query-sync', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: p.dir,
        env: baseEnv,
      })
    git('init', '-q', '-b', 'main')
    await writeFile(join(p.dir, '.gitignore'), '.reeval/\nnode_modules/\nsandboxes/\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    assert.equal((await runCli(p.dir)).code, 0)
    const first = readRun(p.dir).run.runId
    const q1 = await runCli(p.dir, ['query', 'SELECT 1'])
    assert.match(q1.stderr, /history\.db: 1 runs, rebuilt, 1 read/)
    assert.equal((await runCli(p.dir)).code, 0)
    const q2 = await runCli(p.dir, ['query', 'SELECT 1'])
    assert.match(q2.stderr, /history\.db: 2 runs, 1 read$/m, 'only the new run is read')

    assert.equal((await runCli(p.dir, ['record', first])).code, 0)
    const runs = await query(p.dir, 'SELECT run_id, recorded FROM runs ORDER BY run_id')
    assert.deepEqual(
      runs.map((r) => r.recorded),
      [1, 0],
      'the recorded copy replaces the scratch one',
    )
    rmSync(join(p.dir, '.reeval/runs', `${readRun(p.dir).run.runId}.json`))
    assert.equal((await one(p.dir, 'SELECT COUNT(*) AS n FROM runs')).n, 1)
    assert.equal((await one(p.dir, 'SELECT COUNT(*) AS n FROM attempts')).n, 1)
  })

  test('a database from another version, or --rebuild, is rebuilt from the records', async () => {
    const p = await project('query-rebuild', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    await query(p.dir, 'SELECT 1')
    const db = new DatabaseSync(join(p.dir, '.reeval/history.db'))
    db.exec("UPDATE meta SET value = '0' WHERE key = 'version'; DELETE FROM attempts")
    db.close()
    const r = await runCli(p.dir, ['query', 'SELECT COUNT(*) AS n FROM attempts', '--json'])
    assert.match(r.stderr, /rebuilt, 1 read/)
    assert.deepEqual(JSON.parse(r.stdout), [{ n: 1 }])
    const again = await runCli(p.dir, ['query', 'SELECT 1', '--rebuild'])
    assert.match(again.stderr, /rebuilt, 1 read/)
  })

  test('it is read-only and runs one statement; mistakes exit 2 with a fix', async () => {
    const p = await project('query-readonly', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const cases: Array<[string, RegExp]> = [
      [
        'DELETE FROM runs',
        /reeval query is read-only: \.reeval\/history\.db is a projection of the run records/,
      ],
      ['PRAGMA query_only = OFF; DELETE FROM runs', /reeval query runs one statement at a time/],
      ['SELEC 1', /reeval query: near "SELEC": syntax error/],
      [
        'nope',
        /no view or table named "nope"\. Views: drift, effort, eval_trend, factor_effects, failing_attempts/,
      ],
    ]
    for (const [sql, message] of cases) {
      const r = await runCli(p.dir, ['query', sql])
      assert.equal(r.code, 2, `${sql}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    }
    assert.equal((await one(p.dir, 'SELECT COUNT(*) AS n FROM runs')).n, 1, 'nothing was deleted')
  })

  test('failing attempts join skills by environment digest, not name', async () => {
    const p = await project('query-joins', {
      'reeval.config.ts': fakeConfig(),
      'skills/alpha/SKILL.md': skill('alpha'),
      'skills/beta/SKILL.md': skill('beta'),
      'evals/j.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const a = defineEnvironment('tools', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/alpha')],
}))
const b = defineEnvironment('tools', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/beta')],
}))
evaluate('with alpha', { environment: a }, async (c) => { await c.send('x'); throw new Error('no') })
evaluate('with beta', { environment: b }, async (c) => { await c.send('x'); throw new Error('no') })
`,
    })
    assert.equal((await runCli(p.dir)).code, 1)
    const rows = await query(
      p.dir,
      'SELECT eval_key, skill FROM failing_attempts ORDER BY eval_key',
    )
    assert.deepEqual(
      rows.map((r) => r.skill),
      ['alpha', 'beta'],
    )
    // Twin: joining by the environment's name, as the record's names alone allow, mixes them up.
    const byName = await query(
      p.dir,
      `SELECT a.eval_key, s.name FROM attempts a
       JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
       JOIN environments e ON e.run_id = c.run_id AND e.name = c.environment
       JOIN env_skills s ON s.run_id = e.run_id AND s.digest = e.digest`,
    )
    assert.equal(byName.length, 4, 'each attempt matches both environments named tools')
  })

  test('drift names the changed part; flaky cells and verdict flips are found', async () => {
    const p = await project('query-drift', {
      'reeval.config.ts': fakeConfig({
        judge: '{ model: fakeJudge({ score: Number(process.env.REEVAL_TEST_SCORE ?? 0.9) }) }',
      }),
      'evals/helpers.ts': "export const prompt = 'go'\n",
      'evals/unrelated.ts': 'export const x = 1\n',
      'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
import { prompt } from './helpers.ts'
evaluate('flaky', { runs: 3, gate: { passRate: 0.5 } }, async (c) => {
  await c.send(prompt)
  if (c.attempt.n === 2) throw new Error('the second attempt fails')
})
evaluate('judged', async (c) => {
  await c.send(prompt)
  expect(await c.judge('Is it fine?')).toPass()
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    await writeFile(join(p.dir, 'evals/unrelated.ts'), 'export const x = 2\n')
    assert.equal((await runCli(p.dir)).code, 0)
    assert.deepEqual(await query(p.dir, 'drift'), [], 'twin: an unrelated file is no drift')

    await writeFile(join(p.dir, 'evals/helpers.ts'), "export const prompt = 'go!'\n")
    assert.equal((await runCli(p.dir, ['run'], { env: { REEVAL_TEST_SCORE: '0.1' } })).code, 1)
    const drift = await query(p.dir, 'SELECT eval_key, changed FROM drift ORDER BY eval_key')
    assert.deepEqual(drift, [
      { eval_key: 'evals/d.eval.ts › flaky', changed: 'sources' },
      { eval_key: 'evals/d.eval.ts › judged', changed: 'sources' },
    ])

    const [flaky] = await query(p.dir, 'flaky_cells')
    assert.deepEqual(
      [flaky?.eval_key, flaky?.cell_key, flaky?.pass, flaky?.counted],
      ['evals/d.eval.ts › flaky', 'fake/fake/fake', 4, 6],
      'grouped by fingerprint: two runs at the first, one at the second',
    )
    const flips = await query(
      p.dir,
      'SELECT question, prev_pass_rate, pass_rate FROM verdict_flips',
    )
    assert.deepEqual(flips, [{ question: 'Is it fine?', prev_pass_rate: 1, pass_rate: 0 }])
  })
})

describe('reeval query plumbing', () => {
  test('statements are counted outside quotes and comments', () => {
    const cases: Array<[string, number]> = [
      ['SELECT 1', 1],
      ['SELECT 1;', 1],
      ['SELECT 1; SELECT 2', 2],
      ["SELECT ';'", 1],
      ['SELECT 1 -- ; not a statement', 1],
      ['SELECT 1 /* ; */ ;', 1],
      ['SELECT "a;b" FROM t;  ', 1],
      ['', 0],
    ]
    for (const [sql, n] of cases) assert.equal(statementCount(sql), n, sql)
  })

  test('the Node floor is where node:sqlite arrives, in engines too', () => {
    assert.ok(nodeAtLeast('22.13.0') && nodeAtLeast('v24.1.0') && nodeAtLeast('23.0.0'))
    assert.ok(!nodeAtLeast('22.12.9') && !nodeAtLeast('22.6.0') && !nodeAtLeast('20.19.0'))
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, `>=${SQLITE_NODE.replace(/\.0$/, '')}`)
  })
})
