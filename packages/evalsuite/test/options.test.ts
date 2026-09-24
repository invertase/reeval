import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

const config = (extra: string, harness = 'fakeHarness({})') => `
import { defineConfig, secret } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig({
  harness: ${harness},
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  ${extra}
})
`

const SKILL = `---
name: house-greeting
description: The organisation's greeting style. Use when writing greetings.
---

Greet people with "Ahoy, <name>!".
`

describe('matrix, cascade and repeats', () => {
  test('harness lists and runs expand into attempts with per-cell pass rates', async () => {
    const p = await project('matrix', {
      'es.config.ts': config(
        '',
        `[fakeHarness({ id: 'good', files: { 'ok.txt': 'yes' } }), fakeHarness({ id: 'bad' })]`,
      ),
      'evals/m.es.ts': `import { evaluate, expect, group } from 'evalsuite'
group('g', { runs: 2 }, () => {
  evaluate('writes ok.txt', async (t) => {
    await t.send('go')
    expect(t.attempt.n).toBeGreaterThan(0)
    await expect(t).toHaveFile('ok.txt')
  })
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^\[writes#1 good\] ✓ evals\/m\.es\.ts › g › writes ok\.txt/m)
    assert.match(r.stdout, /^\[writes#2 bad\] ✗ evals\/m\.es\.ts › g › writes ok\.txt/m)
    assert.match(
      r.stdout,
      /✗ writes ok\.txt +2\/4 +50% +4 attempts\n +good\/baseline\/fake +2\/2 +100%/,
    )
    assert.match(r.stdout, /bad\/baseline\/fake +0\/2 +0%/)
    assert.match(r.stdout, /2 passed · 2 failed \(4 attempts, 1 evals\)/)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.summary.attempts, 4)
    assert.deepEqual(run.config.harnesses, ['good', 'bad'])
    const [e] = evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.passRate, 0.5)
    assert.deepEqual(
      e?.cells.map((c) => [c.key, c.runs, c.pass, c.passRate, c.outcome]),
      [
        ['good/baseline/fake', 2, 2, 1, 'pass'],
        ['bad/baseline/fake', 2, 0, 0, 'fail'],
      ],
    )
    assert.deepEqual(
      e?.attempts.map((a) => a.id),
      [
        'good/baseline/fake#1',
        'good/baseline/fake#2',
        'bad/baseline/fake#1',
        'bad/baseline/fake#2',
      ],
    )

    const narrowed = await runCli(p.dir, ['run', 'good/', '--runs', '1'])
    assert.equal(narrowed.code, 0, narrowed.stdout)
    assert.deepEqual(
      readRun(p.dir).evals[0]?.attempts.map((a) => a.id),
      ['good/baseline/fake#1'],
      'a filter matches cell keys, and --runs overrides the group',
    )
  })

  test('groups replace the axis, evals can edit it, and options may come last', async () => {
    const p = await project('cascade', {
      'es.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'evals/c.es.ts': `import { evaluate, group } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
group('only c', () => {
  evaluate('replaced', async (t) => { await t.send('x') })
  evaluate('added', { harness: (h) => [...h, fakeHarness({ id: 'd' })] }, async (t) => { await t.send('x') })
}, { harness: fakeHarness({ id: 'c' }) })
evaluate('inherits', async (t) => { await t.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const cells = Object.fromEntries(
      readRun(p.dir).evals.map((e) => [e.name, e.cells.map((c) => c.harness)]),
    )
    assert.deepEqual(cells, { replaced: ['c'], added: ['c', 'd'], inherits: ['a', 'b'] })
  })

  test('option mistakes exit 2 with a hint', async () => {
    const cases: Array<[string, RegExp]> = [
      [
        `group('g', { harnesses: [] }, () => {})`,
        /Unknown option "harnesses" in group\("g"\)\. Did you mean "harness"\?/,
      ],
      [
        `evaluate('e', { repeat: 3 }, async () => {})`,
        /Unknown option "repeat" .*Did you mean "runs"\?/,
      ],
      [
        `evaluate('e', { runs: 0 }, async () => {})`,
        /runs must be a whole number of at least 1 \(got 0\)/,
      ],
      [
        `evaluate('e', { harness: [] }, async () => {})`,
        /harness is an empty list in evaluate\("e"\)/,
      ],
      [
        `evaluate('e', { harness: [fakeHarness(), fakeHarness()] }, async () => {})`,
        /Two harnesss? in evaluate\("e"\) resolve to the id "fake"/,
      ],
    ]
    for (const [body, message] of cases) {
      const p = await project('option-errors', {
        'es.config.ts': fakeConfig(),
        'evals/o.es.ts': `import { evaluate, group } from 'evalsuite'\nimport { fakeHarness } from 'evalsuite/harness'\n${body}\n`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, `${body}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    }
    const literal = await project('literal-secret', {
      'es.config.ts': config(`env: { GOOGLE_API_KEY: 'AIza-not-really' },`),
      'evals/o.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('e', async () => {})\n`,
    })
    const r = await runCli(literal.dir)
    assert.equal(r.code, 2)
    assert.match(
      r.stderr,
      /env\.GOOGLE_API_KEY in es\.config\.ts is a literal string\. Pass secrets with secret\(\)/,
    )
  })

  test('tags filter, todo, for, and a filter that matches nothing exits 2', async () => {
    const p = await project('tags', {
      'es.config.ts': fakeConfig(),
      'evals/t.es.ts': `import { evaluate, group } from 'evalsuite'
group('slow things', { tags: ['slow'] }, () => {
  evaluate('big', async () => {})
  evaluate('bigger', { tags: ['flaky'] }, async () => {})
})
evaluate('quick', async () => {})
evaluate.todo('later')
evaluate.for([{ a: 1, b: 2 }, { a: 3, b: 4 }])('adds $a and $b (%#)', async (t, { a, b }) => {
  if (a + b !== (a === 1 ? 3 : 7)) throw new Error('bad sum')
})
`,
    })
    const slow = await runCli(p.dir, ['run', '--tag', 'slow', '--tag', '!flaky'])
    assert.equal(slow.code, 0, slow.stdout + slow.stderr)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => [e.name, e.tags]),
      [['big', ['slow']]],
    )
    const all = await runCli(p.dir)
    assert.equal(all.code, 0, all.stdout)
    const names = readRun(p.dir).evals.map((e) => [e.name, e.outcome])
    assert.deepEqual(names, [
      ['big', 'pass'],
      ['bigger', 'pass'],
      ['quick', 'pass'],
      ['later', 'skipped'],
      ['adds 1 and 2 (0)', 'pass'],
      ['adds 3 and 4 (1)', 'pass'],
    ])
    const none = await runCli(p.dir, ['run', 'no-such-eval'])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /No evals matched .* with filter "no-such-eval"/)
  })

  test('.only runs alone locally and exits 2 in CI', async () => {
    const p = await project('only', {
      'es.config.ts': fakeConfig(),
      'evals/o.es.ts': `import { evaluate } from 'evalsuite'
evaluate.only('focused', async () => {})
evaluate('other', async () => {})
`,
    })
    const local = await runCli(p.dir)
    assert.equal(local.code, 0, local.stdout + local.stderr)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => [e.name, e.outcome]),
      [
        ['focused', 'pass'],
        ['other', 'skipped'],
      ],
    )
    const { runId } = readRun(p.dir).run
    const ci = await runCli(p.dir, ['run'], { env: { CI: 'true' } })
    assert.equal(ci.code, 2, ci.stdout + ci.stderr)
    assert.match(ci.stderr, /evaluate\.only\/group\.only in evals\/o\.es\.ts isn't allowed in CI/)
    assert.equal(readRun(p.dir).run.runId, runId, 'no run written for a usage error')
    assert.deepEqual(readdirSync(join(p.dir, '.es/staging')), [], 'no staging left behind')

    const groupOnly = await project('group-only', {
      'es.config.ts': fakeConfig(),
      'evals/o.es.ts': `import { evaluate, group } from 'evalsuite'
group.only('focused', () => { evaluate('inside', async () => {}) })
evaluate('other', async () => {})
`,
    })
    const groupCi = await runCli(groupOnly.dir, ['run'], { env: { CI: '1' } })
    assert.equal(groupCi.code, 2, groupCi.stdout + groupCi.stderr)
    assert.match(groupCi.stderr, /isn't allowed in CI/)

    const optOut = await runCli(p.dir, ['run'], { env: { CI: 'false' } })
    assert.equal(optOut.code, 0, 'CI=false, as the message suggests, allows .only')
  })

  test('t.judge without a model names where to set one', async () => {
    const p = await project('no-judge', {
      'es.config.ts': config('').replace('judge: { model: fakeJudge({ score: 0.9 }) },', ''),
      'evals/j.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('judged', async (t) => {
  await t.send('x')
  expect(await t.judge('ok?')).toPass()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /t\.judge\(\) has no model\. Set judge: \{ model: 'typesafe-ai\/jev-1\.13\.0' \} in es\.config\.ts/,
    )
    assert.equal(readRun(p.dir).evals[0]?.error?.kind, 'judge')
  })
})

describe('environments and secrets', () => {
  test('skills, MCP, rules, files, exec steps and secrets reach the sandbox and the record', async () => {
    const p = await project('environments', {
      'es.config.ts': config(`env: { APP_TOKEN: secret('ES_TEST_HOST_TOKEN'), MODE: 'test' },`),
      'skills/house-greeting/SKILL.md': SKILL,
      'skills/house-greeting/examples.md': 'Ahoy, Ada!\n',
      'evals/envs.ts': `import { defineEnvironment } from 'evalsuite'
export const withSkill = defineEnvironment('with-skill', (env) => {
  env.skill('./skills')
  env.mcp('docs', 'npx -y docs-mcp --port 0')
  env.rules('Always write tests.')
  env.file('notes/readme.txt', 'hello')
  env.exec('echo baked > baked.txt')
  env.var('FLAVOUR', 'mint')
  env.secret('EXTRA_TOKEN', 'ES_TEST_HOST_TOKEN')
  env.exec('printf %s "$EXTRA_TOKEN" | wc -c > secret-length.txt', { cache: false })
})
`,
      'evals/e.es.ts': `import { baseline, evaluate, expect } from 'evalsuite'
import { withSkill } from './envs.ts'
evaluate('greets', { environment: [baseline, withSkill] }, async (t) => {
  const turn = await t.send('greet')
  const loaded = turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting; mcp: docs')
  const token = (await t.exec('printf %s "$APP_TOKEN"')).stdout
  expect(token).toBe('s3cret-value-123')
  expect((await t.exec('printf %s "$MODE"')).stdout).toBe('test')
  if (t.attempt.cell.environment === 'baseline') {
    expect(loaded).toBe(false)
    expect(await t.readFile('AGENTS.md')).toBeNull()
    throw new Error('baseline never knows the house style')
  }
  expect(loaded).toBe(true)
  expect(await t.readFile('AGENTS.md')).toBe('Always write tests.')
  expect(await t.readFile('notes/readme.txt')).toBe('hello')
  expect(await t.readFile('baked.txt')).toBe('baked\\n')
  expect((await t.readFile('secret-length.txt'))?.trim()).toBe('16')
  expect((await t.exec('printf %s "$FLAVOUR"')).stdout).toBe('mint')
  expect(turn.diff.files.map((f) => f.path)).not.toContain('AGENTS.md')
})
`,
    })
    const r = await runCli(p.dir, ['run'], { env: { ES_TEST_HOST_TOKEN: 's3cret-value-123' } })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^\[greets#1 with-skill\] ✓ evals\/e\.es\.ts › greets/m)
    assert.match(r.stdout, /with-skill\/fake +1\/1 +100% +lift \+100 pts/)
    const { run, evals, dir } = readRun(p.dir)
    const envs = Object.fromEntries(run.environments.map((e) => [e.name, e]))
    assert.deepEqual(
      envs['with-skill']?.skills.map((s) => [s.name, s.source, s.commit]),
      [['house-greeting', './skills', null]],
    )
    assert.deepEqual(envs['with-skill']?.mcp, ['docs'])
    assert.deepEqual(envs['with-skill']?.secrets, ['APP_TOKEN', 'EXTRA_TOKEN'])
    assert.deepEqual(envs['with-skill']?.vars, ['FLAVOUR', 'MODE'])
    assert.deepEqual(envs['with-skill']?.baked, ['echo baked > baked.txt'])
    assert.deepEqual(envs.baseline?.secrets, ['APP_TOKEN'])
    assert.notEqual(envs.baseline?.digest, envs['with-skill']?.digest)
    const [e] = evals
    assert.deepEqual(e?.attempts[1]?.env, {
      vars: ['FLAVOUR', 'MODE'],
      secrets: ['APP_TOKEN', 'EXTRA_TOKEN'],
    })
    assert.notEqual(e?.cells[0]?.fingerprint, e?.cells[1]?.fingerprint)
    let leaks = ''
    try {
      leaks = execFileSync('grep', ['-r', '-l', 's3cret-value-123', dir], { encoding: 'utf8' })
    } catch {}
    assert.equal(leaks, '', 'the secret value is redacted everywhere')
  })

  test('a missing secret is an infra error; a cached exec that needs one is refused', async () => {
    const p = await project('missing-secret', {
      'es.config.ts': fakeConfig(),
      'evals/s.es.ts': `import { defineEnvironment, evaluate, secret } from 'evalsuite'
evaluate('needs it', { env: { NEEDED: secret('ES_TEST_NOT_SET') } }, async (t) => { await t.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /Secret NEEDED \(from ES_TEST_NOT_SET\) for .* isn't set\. Set it in the environment or \.env\.local\./,
    )

    const baked = await project('baked-secret', {
      'es.config.ts': fakeConfig(),
      'evals/s.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const env = defineEnvironment('login', (env) => {
  env.secret('TOKEN')
  env.exec('login --token "$TOKEN"')
})
evaluate('x', { environment: env }, async () => {})
`,
    })
    const b = await runCli(baked.dir)
    assert.equal(b.code, 2, b.stdout + b.stderr)
    assert.match(
      b.stderr,
      /references the secret TOKEN, but cached steps are baked into an image .* Pass \{ cache: false \}/,
    )
  })

  test('skills come from a git URL at a ref, with the commit recorded', async () => {
    const p = await project('git-skill', { 'es.config.ts': fakeConfig() })
    const repo = join(p.dir, 'skill-repo')
    mkdirSync(join(repo, 'skills/house-greeting'), { recursive: true })
    writeFileSync(join(repo, 'skills/house-greeting/SKILL.md'), SKILL)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'skill')
    git('tag', 'v1')
    const sha = git('rev-parse', 'HEAD')
    mkdirSync(join(p.dir, 'evals'))
    writeFileSync(
      join(p.dir, 'evals/g.es.ts'),
      `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const env = defineEnvironment('remote', (env) => {
  env.skill('file://${repo}', { ref: 'v1', path: 'skills', skills: ['house-greeting'] })
})
evaluate('loads it', { environment: env }, async (t) => {
  const turn = await t.send('x')
  expect(turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting')).toBe(true)
})
`,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const skill = readRun(p.dir).run.environments[0]?.skills[0]
    assert.equal(skill?.commit, sha)
    assert.equal(skill?.source, `file://${repo}#v1:skills`)
  })
})
