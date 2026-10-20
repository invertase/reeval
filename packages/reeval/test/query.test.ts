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
import { type ClassContext, classifyCall } from '../src/history/tool-class.ts'
import { toolTarget } from '../src/history/tool-target.ts'
import { statementCount, usesRunParameter } from '../src/query.ts'
import { harnessLabel } from '../src/view/model.ts'
import { baseEnv, fakeConfig, pkgRoot, project, readRun, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'

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
    assert.deepEqual([lift?.variant_pass_at_1, lift?.control_pass_at_1], [1, 0])
    const cells = await query(p.dir, 'SELECT role, pass_at_1 FROM cells ORDER BY role')
    assert.deepEqual(cells, [
      { role: 'control', pass_at_1: 0 },
      { role: 'variant', pass_at_1: 1 },
    ])

    const failing = await query(p.dir, 'SELECT * FROM failing_attempts')
    assert.equal(failing.length, 3, 'the control fails its three attempts')
    assert.ok(failing.every((f) => f.cell_key === 'fake/plain/fake' && f.skill === null))

    const trend = await query(p.dir, 'eval_trend')
    assert.deepEqual(
      trend.map((t) => [t.eval_key, t.outcome, t.pass_at_1, t.recorded]),
      [['evals/s.eval.ts › greets', 'pass', 1, 0]],
    )

    const text = await runCli(p.dir, ['query', 'SELECT key, outcome FROM evals'])
    assert.equal(text.code, 0, text.stderr)
    assert.equal(text.stdout, 'key                       outcome\nevals/s.eval.ts › greets  pass\n')
    assert.match(text.stderr, /history\.db: 1 runs/)
  })

  test('check_rates gives each labelled check’s pass rate per cell, on both arms of a compare', async () => {
    const p = await project('query-check-rates', {
      'reeval.config.ts': fakeConfig({
        harness:
          "{ files: { 'ok.txt': 'y' }, withSkill: { files: { 'ok.txt': 'y', 'styled.txt': 'Ahoy' } } }",
      }),
      'skills/house/SKILL.md': skill('house'),
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
  await expect.soft(c, 'house style').toHaveFile('styled.txt', /Ahoy/)
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const { run } = readRun(p.dir)
    const cells = await query(p.dir, 'SELECT key, harness FROM cells ORDER BY key')
    const harness = (key: string) => cells.find((c) => c.key === key)?.harness
    assert.ok(harness('fake/plain/fake'))

    const rows = await query(p.dir, 'SELECT * FROM check_rates ORDER BY role, label')
    const row = (cell: string, environment: string, role: string, label: string) => ({
      run_id: run.runId,
      eval_key: 'evals/s.eval.ts › greets',
      cell_key: cell,
      harness: harness(cell),
      environment,
      role,
      label,
    })
    assert.deepEqual(rows, [
      {
        ...row('fake/plain/fake', 'plain', 'control', 'house style'),
        ...{ pass: 0, fail: 2, error: 0, not_run: 0, rate: 0 },
      },
      {
        ...row('fake/plain/fake', 'plain', 'control', 'writes ok.txt'),
        ...{ pass: 2, fail: 0, error: 0, not_run: 0, rate: 1 },
      },
      {
        ...row('fake/styled/fake', 'styled', 'variant', 'house style'),
        ...{ pass: 2, fail: 0, error: 0, not_run: 0, rate: 1 },
      },
      {
        ...row('fake/styled/fake', 'styled', 'variant', 'writes ok.txt'),
        ...{ pass: 2, fail: 0, error: 0, not_run: 0, rate: 1 },
      },
    ])
  })

  test('reasoning effort, requested and served, is its own column; the effort view is the metric', async () => {
    const p = await project('query-reasoning-effort', {
      'reeval.config.ts': fakeConfig({
        harness: "{ id: 'fake', effort: 'high', servedModel: 'fake-1[effort=medium]' }",
      }),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    assert.deepEqual(await one(p.dir, 'SELECT model, reasoning_effort FROM cells'), {
      model: null,
      reasoning_effort: 'high',
    })
    assert.deepEqual(
      await one(
        p.dir,
        'SELECT served_model, reasoning_effort, served_reasoning_effort FROM attempts',
      ),
      {
        served_model: 'fake-1[effort=medium]',
        reasoning_effort: 'high',
        served_reasoning_effort: 'medium',
      },
    )
    const [effort] = await query(p.dir, 'effort')
    assert.equal(effort?.n, 1)
    assert.equal('reasoning_effort' in (effort ?? {}), false)
    const { run } = readRun(p.dir)
    assert.equal(
      harnessLabel(run.stack.harnesses[0] as (typeof run.stack.harnesses)[number]),
      'fake (reasoning effort high, served fake-1[effort=medium], served reasoning effort medium)',
    )
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

  test('SQL that starts with a -- comment is the statement, with flags before, after or --', async () => {
    const p = await project('query-dash-comment', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const sql = '-- attempts per run\nSELECT COUNT(*) AS n FROM attempts'
    for (const argv of [
      ['query', sql, '--json'],
      ['query', '--json', sql],
      ['query', '--json', '--', sql],
      ['query', '-- one line comment\n-- and another\nSELECT 1 AS n', '--json'],
    ]) {
      const r = await runCli(p.dir, argv)
      assert.equal(r.code, 0, `${JSON.stringify(argv)}: ${r.stderr}`)
      assert.deepEqual(JSON.parse(r.stdout), [{ n: 1 }], JSON.stringify(argv))
    }
    const rebuilt = await runCli(p.dir, ['query', sql, '--rebuild', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    assert.match(rebuilt.stderr, /rebuilt, 1 read/)
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
        /no view or table named "nope"\. Views: check_discrimination, check_rates, context_use, contrasts, drift, effort, eval_trend, factor_effects, failing_attempts.*\. Tables: artifacts, assertions, attempt_context, attempts, cell_checks, cells,/,
      ],
    ]
    for (const [sql, message] of cases) {
      const r = await runCli(p.dir, ['query', sql])
      assert.equal(r.code, 2, `${sql}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    }
    assert.equal((await one(p.dir, 'SELECT COUNT(*) AS n FROM runs')).n, 1, 'nothing was deleted')
  })

  test('--run binds :run to a run id or the last run; a view filters on run_id', async () => {
    const p = await project('query-run', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async (c) => { await c.send('x') })\n`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const first = readRun(p.dir).run.runId
    assert.equal((await runCli(p.dir)).code, 0)
    const last = readRun(p.dir).run.runId
    assert.notEqual(first, last)
    const rows = async (args: string[]) => {
      const r = await runCli(p.dir, ['query', ...args, '--json'])
      assert.equal(r.code, 0, r.stdout + r.stderr)
      return JSON.parse(r.stdout) as Row[]
    }
    const byRun = 'SELECT run_id FROM runs WHERE run_id = :run'
    assert.deepEqual(await rows([byRun, '--run', 'last']), [{ run_id: last }])
    assert.deepEqual(await rows([byRun, '--run', first]), [{ run_id: first }])
    assert.deepEqual(await rows(['SELECT $run AS id', '--run', 'last']), [{ id: last }])
    assert.deepEqual(
      (await rows(['eval_trend', '--run', first])).map((r) => r.run_id),
      [first],
      'a bare view name with --run keeps that run’s rows',
    )
    assert.equal((await rows(['eval_trend'])).length, 2, 'without --run, every run')
    assert.deepEqual(
      await rows(["SELECT ':run' AS s"]),
      [{ s: ':run' }],
      'a string, not a parameter',
    )

    const cases: Array<[string[], RegExp]> = [
      [[byRun], /uses :run but no --run was given: pass --run <id\|last>/],
      [['SELECT 1', '--run', 'last'], /--run binds :run, which the statement doesn't use/],
      [[byRun, '--run', 'nope'], /--run nope: no run "nope" in \.reeval\/history\.db/],
      [['flaky_cells', '--run', 'last'], /flaky_cells has no run_id column/],
    ]
    for (const [args, message] of cases) {
      const r = await runCli(p.dir, ['query', ...args])
      assert.equal(r.code, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    }
  })

  test('the text table prints sqlite_schema.sql in full; other long text is clipped', async () => {
    const p = await project('query-sql-column', { 'reeval.config.ts': fakeConfig() })
    const r = await runCli(p.dir, [
      'query',
      "SELECT name, sql FROM sqlite_master WHERE name = 'runs'",
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /…/)
    assert.match(r.stdout, /CREATE TABLE runs \([\s\S]*skipped INTEGER\n\)/)
    const long = await runCli(p.dir, ['query', `SELECT '${'x'.repeat(80)}' AS other`])
    assert.match(long.stdout, /x…$/m)
  })

  test('skill_reads counts a dedicated skill load, not only a path under skills/', async () => {
    const p = await project('query-skill-reads', {
      'reeval.config.ts': fakeConfig({
        harness:
          "{ tools: [{ tool: 'skill', input: { id: 'house-greeting' }, output: 'loaded' }] }",
      }),
      'skills/house-greeting/SKILL.md': skill('house-greeting'),
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/house-greeting')],
}))
evaluate('loads', { environment: skilled }, async (c) => {
  await c.send('go')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const rows = await query(
      p.dir,
      'SELECT skill, reads, read_line IS NOT NULL AS opened FROM skill_reads',
    )
    assert.deepEqual(rows, [{ skill: 'house-greeting', reads: 1, opened: 1 }])
  })

  test('a shell word with an unbalanced [ is read literally, not as a regex', async () => {
    const commands = ['echo [foo', 'node -e "a[0"', 'cat {a[0,b}', 'ls {*,b[}']
    const tools = commands.map((command) => ({ tool: 'shell', input: { command }, output: '' }))
    const p = await project('query-unbalanced-bracket', {
      'reeval.config.ts': fakeConfig({ harness: `{ tools: ${JSON.stringify(tools)} }` }),
      'skills/house-greeting/SKILL.md': skill('house-greeting'),
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox: fakeSandbox(),
  skills: [skill.local('../skills/house-greeting')],
}))
evaluate('brackets', { environment: skilled }, async (c) => {
  await c.send('go')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const rows = await query(p.dir, 'SELECT target, class FROM tool_calls ORDER BY line')
    assert.deepEqual(
      rows,
      commands.map((target) => ({ target, class: 'workspace' })),
    )
    assert.equal((await query(p.dir, 'effort')).length, 1)
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
      [flaky?.eval_key, flaky?.cell_key, flaky?.pass, flaky?.counted, flaky?.pass_at_1],
      ['evals/d.eval.ts › flaky', 'fake/fake/fake', 4, 6, 0.667],
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

  test(':run is found outside quotes and comments only', () => {
    const cases: Array<[string, boolean]> = [
      ['SELECT * FROM runs WHERE run_id = :run', true],
      ['SELECT $run', true],
      ['SELECT @run', true],
      ["SELECT ':run'", false],
      ['SELECT ":run" FROM t', false],
      ['SELECT 1 -- :run', false],
      ['SELECT 1 /* :run */', false],
      ['SELECT :runner', false],
      ['SELECT run FROM t', false],
    ]
    for (const [sql, uses] of cases) assert.equal(usesRunParameter(sql), uses, sql)
  })

  test('the Node floor is where node:sqlite arrives, in engines too', () => {
    assert.ok(nodeAtLeast('22.13.0') && nodeAtLeast('v24.1.0') && nodeAtLeast('23.0.0'))
    assert.ok(!nodeAtLeast('22.12.9') && !nodeAtLeast('22.6.0') && !nodeAtLeast('20.19.0'))
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, `>=${SQLITE_NODE.replace(/\.0$/, '')}`)
  })
})

describe('tool-call classes', () => {
  const ctx: ClassContext = {
    skills: ['fui-new'],
    files: [
      '~/.agents/skills/fui-new/SKILL.md',
      '~/.agents/skills/fui-new/references/react.md',
      '~/.agents/skills/fui-new/references/angular.md',
      'AGENTS.md',
    ],
    mcp: ['docs'],
    verify: ['test -s src/App.tsx'],
  }
  const cls = (tool: string, target: string) => classifyCall(tool, target, ctx)

  test('a read of a placed file is context, by absolute path, ~ or a glob', () => {
    assert.deepEqual(cls('read', '/home/reeval/.agents/skills/fui-new/SKILL.md'), {
      class: 'context',
      files: ['~/.agents/skills/fui-new/SKILL.md'],
    })
    assert.deepEqual(cls('shell', 'cat ~/.agents/skills/*/references/{react,core}.md'), {
      class: 'context',
      files: ['~/.agents/skills/fui-new/references/react.md'],
    })
    assert.deepEqual(cls('read', 'AGENTS.md'), { class: 'context', files: ['AGENTS.md'] })
    assert.equal(cls('shell', 'ls ~/.agents/skills/fui-new/references').class, 'context')
    assert.equal(cls('Skill', 'fui-new').class, 'context')
    assert.equal(cls('mcp__docs__search', '{"q":"x"}').class, 'context')
    assert.deepEqual(
      cls('shell', `/bin/bash -lc "sed -n '1,260p' /home/reeval/.agents/skills/fui-new/SKILL.md"`),
      { class: 'context', files: ['~/.agents/skills/fui-new/SKILL.md'] },
    )
    assert.deepEqual(
      cls('glob', '**/SKILL.md'),
      { class: 'workspace', files: [] },
      'a glob from the workspace never reaches home',
    )
    assert.equal(toolTarget({ skill: 'fui-new' }, 'Skill'), 'fui-new')
    assert.deepEqual(cls('Skill', toolTarget({ skill: 'fui-new' }, 'Skill')).files, [
      '~/.agents/skills/fui-new/SKILL.md',
    ])
  })

  test('digging in installed packages is dependency; an exclusion of them is not', () => {
    assert.equal(cls('read', 'node_modules/@fui/react/index.d.ts').class, 'dependency')
    assert.equal(
      cls(
        'shell',
        'grep -rn "onSignIn|SignInAuthScreenProps" node_modules/@fui/react/dist/index.d.ts',
      ).class,
      'dependency',
    )
    assert.equal(cls('shell', 'npx fui --help').class, 'dependency')
    assert.equal(
      cls('shell', 'find . -maxdepth 3 -not -path "*/node_modules/*" -type f').class,
      'workspace',
    )
    assert.equal(
      cls('shell', 'find . -path ./node_modules -prune -o -name "*.tsx" -print').class,
      'workspace',
    )
    assert.equal(cls('shell', 'grep -rn signIn . --exclude-dir=node_modules').class, 'workspace')
    assert.equal(cls('shell', "rg signIn -g '!node_modules'").class, 'workspace')
    assert.equal(cls('shell', 'ls | grep -v node_modules').class, 'workspace')
    assert.equal(cls('shell', '[ -d node_modules ] && echo yes').class, 'workspace')
  })

  test('checks, builds and the web have their own classes; the rest is workspace', () => {
    assert.equal(cls('shell', 'test -s src/App.tsx').class, 'verify')
    assert.equal(cls('shell', 'npx tsc --noEmit').class, 'verify')
    assert.equal(cls('bash', 'pnpm run build').class, 'verify')
    assert.equal(cls('shell', 'curl -s https://example.com/docs').class, 'web')
    assert.equal(cls('web_fetch', 'https://example.com').class, 'web')
    assert.equal(cls('edit', 'src/App.tsx').class, 'workspace')
    assert.equal(cls('read', '~/.agents/skills/other/SKILL.md').class, 'workspace')
  })

  test('glob words never throw: [ is literal, and braces hold globs, not regexes', () => {
    for (const command of ['echo [foo', 'cat {a[0,b}', 'ls {x*,b[}', 'cat {?,(}', 'ls *[']) {
      assert.deepEqual(cls('shell', command), { class: 'workspace', files: [] }, command)
    }
    assert.deepEqual(cls('shell', 'cat ~/.agents/skills/fui-new/references/{re*,x}.md'), {
      class: 'context',
      files: ['~/.agents/skills/fui-new/references/react.md'],
    })
    assert.equal(cls('shell', 'cat AGENTS.m[d]').class, 'workspace')
  })
})

describe('context_use and skill_files on real runs', () => {
  test('each harness opened its placed SKILL.md; web and MCP calls have their classes', async () => {
    const p = await fixture('fixtures/records/real-contract')
    const q = async (sql: string) => {
      const r = await runCli(p.dir, ['query', sql, '--json'])
      assert.equal(r.code, 0, r.stderr)
      return JSON.parse(r.stdout) as Array<Record<string, unknown>>
    }
    const reads = await q(
      "SELECT attempt_id, MAX(reads) AS reads FROM skill_files WHERE path LIKE '%/contract-probe/SKILL.md' GROUP BY attempt_id ORDER BY attempt_id",
    )
    assert.deepEqual(
      reads.map((r) => [String(r.attempt_id).split(':')[0], (r.reads as number) > 0]),
      [
        ['claude-code', true],
        ['codex', true],
        ['cursor', true],
      ],
    )
    const classes = await q(
      "SELECT attempt_id, class FROM context_use WHERE class IN ('web', 'context') ORDER BY attempt_id, class",
    )
    const of = (part: string) =>
      classes.filter((r) => String(r.attempt_id).includes(`/${part}/`)).map((r) => r.class)
    assert.ok(of('closed').every((c) => c === 'web') && of('closed').length > 0)
    assert.ok(of('stamped').every((c) => c === 'context') && of('stamped').length > 0)
    const unclaimed = await q(
      "SELECT COUNT(*) AS n FROM skill_files WHERE path LIKE '%/.system/%' OR path LIKE '%.ai-sdk-harness-skills.json' OR path LIKE '~/.codex/config.toml'",
    )
    assert.equal(
      unclaimed[0]?.n,
      0,
      'a CLI\u2019s own skills and home config are not the environment\u2019s',
    )
  })
})
