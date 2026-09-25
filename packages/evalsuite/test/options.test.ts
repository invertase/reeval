import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

const config = (extra: string, harness = 'fakeHarness({})') => `
import { defineConfig } from 'evalsuite'
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

const REVIEWER_DESCRIPTION = `Reviews an agent skill before it ships: frontmatter, triggering and
progressive disclosure.
Use when: someone asks for a skill review.`

/** A fake agent that writes ok.txt only when it's given a skill. */
const SKILLED = `fakeHarness({ withSkill: { files: { 'ok.txt': 'yes' } } })`

describe('harness matrix, cascade and runs', () => {
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
    assert.match(r.stdout, /^plan {2}1 eval · 2 cells · 4 attempts · ~/m)
    assert.match(r.stdout, /^\[writes#1 good\] ✓ evals\/m\.es\.ts › g › writes ok\.txt/m)
    assert.match(r.stdout, /^\[writes#2 bad\] ✗ evals\/m\.es\.ts › g › writes ok\.txt/m)
    assert.match(r.stdout, /✗ writes ok\.txt +2\/4 +50% +4 attempts\n +good\/-\/fake +2\/2 +100%/)
    assert.match(r.stdout, /bad\/-\/fake +0\/2 +0%/)
    assert.match(r.stdout, /2 passed · 2 failed \(4 attempts, 1 evals\)/)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.summary.attempts, 4)
    assert.deepEqual(run.config.harnesses, ['good', 'bad'])
    assert.deepEqual(run.plan, { evals: 1, cells: 2, attempts: 4, estimateMs: run.plan.estimateMs })
    const [e] = evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.passRate, 0.5)
    assert.deepEqual(
      e?.cells.map((c) => [c.key, c.role, c.gated, c.runs, c.pass, c.passRate, c.outcome]),
      [
        ['good/-/fake', 'control', true, 2, 2, 1, 'pass'],
        ['bad/-/fake', 'control', true, 2, 0, 0, 'fail'],
      ],
    )
    assert.deepEqual(
      e?.attempts.map((a) => a.id),
      ['good/-/fake#1', 'good/-/fake#2', 'bad/-/fake#1', 'bad/-/fake#2'],
    )

    const narrowed = await runCli(p.dir, ['run', 'good/', '--runs', '1'])
    assert.equal(narrowed.code, 0, narrowed.stdout)
    assert.deepEqual(
      readRun(p.dir).evals[0]?.attempts.map((a) => a.id),
      ['good/-/fake#1'],
      'a filter matches cell keys, and --runs overrides the group',
    )
  })

  test('groups replace the harness list, evals can edit it, and options may come last', async () => {
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

describe('compare', () => {
  const envs = `import { defineEnvironment } from 'evalsuite'
export const base = defineEnvironment('base', { env: { MODE: 'base' } })
export const skilled = base.extend('skilled', ({ skill }) => ({
  env: { MODE: 'skilled' },
  skills: [skill.local('../skills')],
}))
`

  test('variants run next to the control, lift is stored, and the control is not gated', async () => {
    const p = await project('compare', {
      'es.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.es.ts': `import { evaluate, expect, group } from 'evalsuite'
import { base, skilled } from './envs.ts'
group('g', { environment: base, compare: [skilled], runs: 2 }, () => {
  evaluate('writes ok.txt', async (t) => {
    await t.send('go')
    const mode = (await t.exec('printf %s "$MODE"')).stdout
    expect(mode).toBe(t.attempt.cell.role === 'control' ? 'base' : 'skilled')
    await expect(t).toHaveFile('ok.txt')
  })
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^plan {2}1 eval · 2 cells · 4 attempts/m)
    assert.match(r.stdout, /^\[writes#1 control\] ✗ .*\(not gated\)$/m)
    assert.match(r.stdout, /^\[writes#1 skilled\] ✓ /m)
    assert.match(r.stdout, /fake\/base\/fake +control +0\/2 +0% +not gated/)
    assert.match(r.stdout, /fake\/skilled\/fake +variant +2\/2 +100% +lift \+100 pts/)
    assert.match(r.stdout, /overrides: env\.MODE/)
    assert.match(r.stdout, /2 passed · 2 failed, not gated \(4 attempts, 1 evals\)/)
    const { run, evals } = readRun(p.dir)
    const [e] = evals
    assert.equal(e?.outcome, 'pass', 'the ungated control fails without failing the eval')
    assert.equal(run.summary.notGated, 2)
    const [control, variant] = e?.cells ?? []
    assert.deepEqual(
      [control?.role, control?.gated, variant?.role, variant?.variant, variant?.gated],
      ['control', false, 'variant', 'skilled', true],
    )
    assert.deepEqual(variant?.lift, {
      vs: 'fake/base/fake',
      points: 1,
      controlPassRate: 0,
      variantPassRate: 1,
      n: 2,
    })
    assert.deepEqual(variant?.overrides, ['env.MODE'])
    const envRecords = Object.fromEntries(run.environments.map((x) => [x.name, x]))
    assert.equal(envRecords.skilled?.parent, 'base')
    assert.deepEqual(envRecords.skilled?.overrides, ['env.MODE'])
    assert.deepEqual(
      envRecords.skilled?.skills.map((s) => [s.name, s.source, s.placement]),
      [['house-greeting', 'local:skills', 'harness']],
    )
    assert.match(readRun(p.dir).read('summary.md'), /fake\/skilled\/fake 2\/2 \(lift \+100 pts/)
  })

  test("gate 'all' gates the control, and minLift fails a variant cell below it", async () => {
    const p = await project('compare-gates', {
      'es.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.es.ts': `import { evaluate, expect } from 'evalsuite'
import { base, skilled } from './envs.ts'
evaluate('all gated', { environment: base, compare: { variants: [skilled], gate: 'all' } }, async (t) => {
  await t.send('go')
  await expect(t).toHaveFile('ok.txt')
})
evaluate('no worse', { compare: { variants: [skilled], minLift: 0.5, gate: 'none' } }, async (t) => {
  await t.send('go')
  if (t.attempt.cell.role === 'variant') throw new Error('the variant is worse')
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [all, noWorse] = readRun(p.dir).evals
    assert.equal(all?.outcome, 'fail', 'a gated control fails the eval')
    assert.equal(all?.cells[0]?.gated, true)
    assert.equal(noWorse?.cells[1]?.lift?.points, -1)
    assert.equal(noWorse?.cells[1]?.outcome, 'fail')
    assert.equal(noWorse?.outcome, 'pass', "gate 'none' reports but never fails")
    assert.match(r.stdout, /lift −100 pts \(minLift 50\) ✗/)
  })

  test('compare.harness scopes variants; other harnesses run the control only', async () => {
    const p = await project('compare-scope', {
      'es.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.es.ts': `import { evaluate } from 'evalsuite'
import { skilled } from './envs.ts'
evaluate('scoped', { compare: { variants: [skilled], harness: ['b'] } }, async (t) => { await t.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(
      readRun(p.dir).evals[0]?.cells.map((c) => c.key),
      ['a/-/fake', 'b/-/fake', 'b/skilled/fake'],
    )
  })
})

describe('profiles', () => {
  const profiles = `
  defaultProfile: { ci: 'pr' },
  profiles: {
    pr: { limit: { runs: 1, compare: false, harness: ['a'] }, budget: { attempts: 5 }, tags: ['!nightly-only'] },
    nightly: { defaults: { runs: 3, harness: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })] } },
  },`
  const evals = `import { defineEnvironment, evaluate } from 'evalsuite'
const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })
evaluate('plain', { runs: 3 }, async (t) => { await t.send('x') })
evaluate('compared', { compare: [skilled] }, async (t) => { await t.send('x') })
evaluate('regression', { compare: [skilled], runs: 2, pin: ['compare', 'runs'] }, async (t) => { await t.send('x') })
evaluate('own harness', { harness: fakeHarness({ id: 'b' }) }, async (t) => { await t.send('x') })
evaluate('slow', { tags: ['nightly-only'] }, async (t) => { await t.send('x') })
`
  const setup = () =>
    project('profiles', {
      'es.config.ts': config(profiles, `fakeHarness({ id: 'a' })`),
      'evals/p.es.ts': `import { fakeHarness } from 'evalsuite/harness'\n${evals}`,
    })

  test('a limit narrows unless pinned, and --dry-run prints the plan without running', async () => {
    const p = await setup()
    const r = await runCli(p.dir, ['run', '--dry-run'], { env: { CI: 'true' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^plan {2}profile pr \(auto: CI is set\) · 3 evals \(1 skipped\) · 4 cells · 6 attempts · ~.* · budget 5 attempts ✗$/m,
    )
    assert.match(r.stdout, /evals\/p\.es\.ts › plain +1 +— +1 +1 +runs 3 → 1 \(profile pr\)/)
    assert.match(
      r.stdout,
      /evals\/p\.es\.ts › compared +1 +0 of 1 +1 +1 +compare off \(profile pr\)/,
    )
    assert.match(r.stdout, /evals\/p\.es\.ts › regression +1 +1 +2 +4 +pinned: compare, runs/)
    assert.match(
      r.stdout,
      /evals\/p\.es\.ts › own harness +0 +— +1 +0 +skipped: no harness left: profile pr allows a/,
    )
    assert.doesNotMatch(r.stdout, /› slow/, "the profile's tag filter drops it")
    assert.equal(existsSync(join(p.dir, '.es/runs')), false, 'a dry run writes no run')

    const over = await runCli(p.dir, ['run'], { env: { CI: 'true' } })
    assert.equal(over.code, 2, over.stdout + over.stderr)
    assert.match(
      over.stderr,
      /this run plans 6 attempts, over budget\.attempts 5 \(profile pr\)\. Narrow it with --tag or --runs, or raise the budget\. \(--force runs it anyway\)/,
    )
    const forced = await runCli(p.dir, ['run', '--force'], { env: { CI: 'true' } })
    assert.equal(forced.code, 0, forced.stdout + forced.stderr)
    const { run, evals: ran } = readRun(p.dir)
    assert.deepEqual(
      [run.profile?.name, run.profile?.reason, run.profile?.limit.runs],
      ['pr', 'auto: CI is set', 1],
    )
    assert.deepEqual(
      ran.map((e) => [e.name, e.attempts.length, e.outcome]),
      [
        ['plain', 1, 'pass'],
        ['compared', 1, 'pass'],
        ['regression', 4, 'pass'],
        ['own harness', 1, 'skipped'],
      ],
    )
  })

  test('defaults sit under evals; --profile and ES_PROFILE pick one; typos exit 2', async () => {
    const p = await setup()
    const nightly = await runCli(p.dir, ['run', '--dry-run', '--profile', 'nightly'])
    assert.equal(nightly.code, 0, nightly.stdout + nightly.stderr)
    assert.match(
      nightly.stdout,
      /^plan {2}profile nightly \(--profile\) · 5 evals · 13 cells · 35 attempts/m,
    )
    assert.match(nightly.stdout, /› plain +2 +— +3 +6/, 'the eval keeps its own runs')
    assert.match(nightly.stdout, /› own harness +1 +— +3 +3 +harness set by the eval/)
    const env = await runCli(p.dir, ['run', '--dry-run'], { env: { ES_PROFILE: 'nightly' } })
    assert.match(env.stdout, /^plan {2}profile nightly \(ES_PROFILE\)/m)
    const none = await runCli(p.dir, ['run', '--dry-run'])
    assert.match(none.stdout, /^plan {2}5 evals · 7 cells · 11 attempts/m, 'no profile locally')
    const typo = await runCli(p.dir, ['run', '--profile', 'nigthly'])
    assert.equal(typo.code, 2)
    assert.match(
      typo.stderr,
      /es: Unknown profile "nigthly"\. Profiles in es\.config\.ts: pr, nightly\./,
    )
  })

  test('budget.duration stops new attempts; the run is marked budget and exits 1', async () => {
    const p = await project('budget-duration', {
      'es.config.ts': config(
        `concurrency: 1, budget: { duration: '1s' },`,
        'fakeHarness({ delayMs: 700 })',
      ),
      'evals/b.es.ts': `import { evaluate } from 'evalsuite'
evaluate('slow', { runs: 4 }, async (t) => { await t.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /Budget: 1s reached; running attempts finish, queued ones are skipped/)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.status, 'budget')
    assert.deepEqual(run.budget, { duration: '1s' })
    const outcomes = evals[0]?.attempts.map((a) => a.outcome) ?? []
    assert.ok(outcomes.includes('pass') && outcomes.includes('skipped'), outcomes.join(','))
  })
})

describe('common mistakes', () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      'a list of environments',
      `group('genkit', { environment: [a, b] }, () => {})`,
      /environment takes one environment, not a list \(group\("genkit"\)\)\. To compare environments, use compare: \[a, b\]; the inherited environment is the control\./,
    ],
    [
      'a variant with its own checks',
      `evaluate('e', { compare: [{ environment: a, check: () => {} }] }, async () => {})`,
      /compare takes environments \(got an object with "environment", "check"\) in evaluate\("e"\)\. Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval\./,
    ],
    [
      'compare scoped to a harness the eval does not run',
      `evaluate('e', { compare: { variants: [a], harness: ['sonnet'] } }, async () => {})`,
      /compare\.harness lists sonnet, which evaluate\("e"\) doesn't run \(it runs fake\)\./,
    ],
    [
      'importing baseline',
      `evaluate('e', { compare: [(await import('evalsuite') as never as { baseline: never }).baseline] }, async () => {})`,
      /compare lists undefined in evaluate\("e"\)\. evalsuite has no baseline: the inherited environment is the control of compare; with none, the control is empty\./,
    ],
    [
      'pinning something that cannot be pinned',
      `evaluate('e', { pin: ['timeout'] }, async () => {})`,
      /pin accepts harness, runs and compare \(got timeout\)/,
    ],
    [
      'a callback as group options',
      `group('genkit', ({ secret }) => ({ env: { KEY: secret.fromEnv('KEY') } }), () => {})`,
      /group\("genkit"\) got two functions\. Options must be a plain object; helpers such as secret are only available in defineConfig and defineEnvironment callbacks\./,
    ],
    [
      'image steps on an environment',
      `defineEnvironment('firebase', { image: ['npm i -g firebase-tools'] })`,
      /"image" isn't an environment field \(defineEnvironment\("firebase"\)\)\. What's baked into the image is the sandbox's: docker\(\{ install: … \}\)\. An environment only runs setup steps, in every attempt, with its secrets\./,
    ],
    [
      'a dockerfile on an environment',
      `defineEnvironment('py', { dockerfile: './Dockerfile' })`,
      /"dockerfile" isn't an environment field \(defineEnvironment\("py"\)\)\. What's baked into the image is the sandbox's: docker\(\{ dockerfile: … \}\)/,
    ],
    [
      'an async callback',
      `defineEnvironment('docs', async ({ file }) => ({ files: { 'docs/llms.txt': 'x' } }))`,
      /defineEnvironment\("docs"\) returned a Promise\. The callback runs once at definition time and must return the environment synchronously; fetch remote content in a setup step instead\./,
    ],
    [
      'a list of sandboxes',
      `evaluate('e', { sandbox: [fakeSandbox(), fakeSandbox()] }, async () => {})`,
      /sandbox takes one sandbox, not a list \(evaluate\("e"\)\)/,
    ],
    [
      'an old option name',
      `group('g', { harnesses: [] }, () => {})`,
      /Unknown option "harnesses" in group\("g"\)\. Did you mean "harness"\?/,
    ],
    [
      'repeat instead of runs',
      `evaluate('e', { repeat: 3 }, async () => {})`,
      /Unknown option "repeat" .*Did you mean "runs"\?/,
    ],
    [
      'runs 0',
      `evaluate('e', { runs: 0 }, async () => {})`,
      /runs must be a whole number of at least 1 \(got 0\)/,
    ],
    [
      'no harness',
      `evaluate('e', { harness: [] }, async () => {})`,
      /harness is an empty list in evaluate\("e"\)/,
    ],
    [
      'two harnesses with one id',
      `evaluate('e', { harness: [fakeHarness(), fakeHarness()] }, async () => {})`,
      /Two harnesses in evaluate\("e"\) resolve to the id "fake"/,
    ],
  ]
  for (const [what, body, message] of cases) {
    test(`${what} exits 2 with a fix`, async () => {
      const p = await project('mistake', {
        'es.config.ts': fakeConfig(),
        'evals/o.es.ts': `import { defineEnvironment, evaluate, group } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
const a = defineEnvironment('a', {})
const b = defineEnvironment('b', {})
${body}
`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, `${body}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    })
  }

  const configCases: Array<[string, string, RegExp]> = [
    [
      'compare in the config',
      `compare: [defineEnvironment('x', {})],`,
      /compare can't be set in es\.config\.ts: it would multiply every eval\. Put it on the group or eval that asks the question\./,
    ],
    [
      'a literal secret',
      `env: { GOOGLE_API_KEY: 'AIza-not-really' },`,
      /env\.GOOGLE_API_KEY in es\.config\.ts is a literal string\. Pass secrets with secret\.fromEnv\(\) so they're redacted and never recorded\./,
    ],
    [
      'widening in a profile limit',
      `profiles: { pr: { limit: { harness: [fakeHarness({ id: 'a' })] } } },`,
      /profiles\.pr\.limit\.harness can only list harness ids to allow \(got fake\(\{ … \}\)\)\. To add harnesses, use profiles\.pr\.defaults\.harness\./,
    ],
    [
      'a usd budget',
      `budget: { usd: 20 },`,
      /budget\.usd isn't supported: no harness ES runs reports cost or tokens yet \(Cursor reports no usage\)\. Cap the run with attempts or duration\./,
    ],
    [
      'control reuse',
      `profiles: { pr: { reuse: 'control' } },`,
      /Unknown option "reuse" in profiles\.pr\. Reusing control results from \.history isn’t built yet/,
    ],
  ]
  for (const [what, extra, message] of configCases) {
    test(`${what} exits 2 with a fix`, async () => {
      const p = await project('config-mistake', {
        'es.config.ts': config(extra).replace(
          "import { defineConfig } from 'evalsuite'",
          "import { defineConfig, defineEnvironment } from 'evalsuite'",
        ),
        'evals/o.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('e', async () => {})\n`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, `${extra}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    })
  }

  test('a moving git ref warns in the plan', async () => {
    const p = await project('moving-ref', {
      'es.config.ts': fakeConfig(),
      'evals/o.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const main = defineEnvironment('skill@main', ({ skill }) => ({
  skills: [skill.git('github:invertase/genkit-skills', { ref: 'main' })],
}))
evaluate('e', { environment: main }, async () => {})
`,
    })
    const r = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^warning: skill\.git\(github:invertase\/genkit-skills\) uses moving ref "main": results aren't comparable over time\. Pin a tag or SHA \(the resolved commit is recorded either way\)\.$/m,
    )
  })
})

describe('environments and secrets', () => {
  test('skills, MCP, rules, files, setup steps and secrets reach the sandbox and the record', async () => {
    const p = await project('environments', {
      'es.config.ts': `
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig(({ secret }) => ({
  harness: fakeHarness({}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  env: { APP_TOKEN: secret.fromEnv('ES_TEST_HOST_TOKEN'), MODE: 'test' },
}))
`,
      'skills/house-greeting/SKILL.md': SKILL,
      'skills/house-greeting/examples.md': 'Ahoy, Ada!\n',
      'docs/api.md': '# API\n',
      'evals/envs.ts': `import { defineEnvironment } from 'evalsuite'
export const withSkill = defineEnvironment('with-skill', ({ file, mcp, secret, skill }) => ({
  skills: [skill.local('../skills')],
  mcp: { docs: mcp.stdio('npx', ['-y', 'docs-mcp', '--port', '0']) },
  rules: 'Always write tests.',
  files: { 'notes/readme.txt': 'hello', 'docs/api.md': file('../docs/api.md') },
  env: {
    FLAVOUR: 'mint',
    EXTRA_TOKEN: secret.fromEnv('ES_TEST_HOST_TOKEN'),
    CHECK_TOKEN: secret.fromEnv('ES_TEST_HOST_TOKEN', { to: 'checks' }),
    MAYBE_TOKEN: secret.fromEnv('ES_TEST_NOT_SET', { optional: true }),
  },
  setup: [{ run: 'printf %s "$EXTRA_TOKEN$CHECK_TOKEN" | wc -c > secret-length.txt', timeout: '10s' }],
}))
`,
      'evals/e.es.ts': `import { evaluate, expect } from 'evalsuite'
import { withSkill } from './envs.ts'
evaluate('greets', { compare: [withSkill] }, async (t) => {
  const turn = await t.send('greet')
  const loaded = turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting; mcp: docs')
  const token = (await t.exec('printf %s "$APP_TOKEN"')).stdout
  expect(token).toBe('s3cret-value-123')
  expect((await t.exec('printf %s "$MODE"')).stdout).toBe('test')
  if (t.attempt.cell.role === 'control') {
    expect(loaded).toBe(false)
    expect(await t.readFile('AGENTS.md')).toBeNull()
    throw new Error('the control never knows the house style')
  }
  expect(loaded).toBe(true)
  expect(await t.readFile('AGENTS.md')).toBe('Always write tests.')
  expect(await t.readFile('notes/readme.txt')).toBe('hello')
  expect(await t.readFile('docs/api.md')).toBe('# API\\n')
  expect((await t.readFile('secret-length.txt'))?.trim()).toBe('32')
  expect((await t.exec('printf %s "$FLAVOUR"')).stdout).toBe('mint')
  expect((await t.exec('printf %s "$CHECK_TOKEN"')).stdout).toBe('s3cret-value-123')
  expect(turn.diff.files.map((f) => f.path)).not.toContain('AGENTS.md')
})
`,
    })
    const r = await runCli(p.dir, ['run'], { env: { ES_TEST_HOST_TOKEN: 's3cret-value-123' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^\[greets#1 with-skill\] ✓ evals\/e\.es\.ts › greets/m)
    assert.match(r.stdout, /with-skill\/fake +variant +1\/1 +100% +lift \+100 pts/)
    const { run, evals, dir } = readRun(p.dir)
    const envs = Object.fromEntries(run.environments.map((e) => [e.name, e]))
    assert.deepEqual(Object.keys(envs), ['with-skill'], 'the empty control records no environment')
    const w = envs['with-skill']
    assert.deepEqual(
      w?.skills.map((s) => [s.name, s.source, s.commit]),
      [['house-greeting', 'local:skills', null]],
    )
    assert.deepEqual(w?.mcp, ['docs'])
    assert.deepEqual(w?.secrets, ['APP_TOKEN', 'CHECK_TOKEN', 'EXTRA_TOKEN'])
    assert.deepEqual(w?.unset, ['MAYBE_TOKEN'])
    assert.deepEqual(w?.vars, ['FLAVOUR', 'MODE'])
    assert.equal('image' in (w ?? {}), false, 'environments record no image steps')
    assert.equal(w?.setup.length, 1)
    const [e] = evals
    const variant = e?.attempts.find((a) => a.cell === 'fake/with-skill/fake')
    assert.deepEqual(variant?.env, {
      vars: ['FLAVOUR', 'MODE'],
      secrets: ['APP_TOKEN', 'CHECK_TOKEN', 'EXTRA_TOKEN'],
    })
    assert.ok(variant?.files.setupLog, 'setup steps write setup.log')
    assert.match(readRun(p.dir).read(variant?.files.setupLog?.path ?? ''), /exit 0 after \d+ms/)
    assert.notEqual(e?.cells[0]?.fingerprint, e?.cells[1]?.fingerprint)
    let leaks = ''
    try {
      leaks = execFileSync('grep', ['-r', '-l', 's3cret-value-123', dir], { encoding: 'utf8' })
    } catch {}
    assert.equal(leaks, '', 'the secret value is redacted everywhere')
  })

  test('a missing secret is an infra error; a failing setup step names itself', async () => {
    const p = await project('missing-secret', {
      'es.config.ts': fakeConfig(),
      'evals/s.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const needs = defineEnvironment('needs', ({ secret }) => ({ env: { NEEDED: secret.fromEnv('ES_TEST_NOT_SET') } }))
evaluate('needs it', { environment: needs }, async (t) => { await t.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /Secret NEEDED \(from ES_TEST_NOT_SET\) for environment needs .* isn't set\. Set it in the environment or \.env\.local\./,
    )

    const failing = await project('setup-fails', {
      'es.config.ts': fakeConfig(),
      'evals/s.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const broken = defineEnvironment('broken', { setup: [{ run: 'true' }, { run: 'echo nope >&2; exit 4' }] })
evaluate('x', { environment: broken, timeout: '1s' }, async (t) => { await t.send('x') })
`,
    })
    const f = await runCli(failing.dir)
    assert.equal(f.code, 3, f.stdout + f.stderr)
    assert.match(
      f.stdout,
      /setup step 2\/2 "echo nope >&2; exit 4" in environment broken exited 4 after \d+ms \(see setup\.log\):\n.*nope/,
    )
  })

  test('skills come from a git URL at a ref, with the commit recorded; workspace placement', async () => {
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
const env = defineEnvironment('remote', ({ skill }) => ({
  skills: [
    skill.git('file://${repo}', { ref: 'v1', path: 'skills', only: ['house-greeting'] }),
    skill.inline({ name: 'house-rules', description: 'Rules.', content: 'Be nice.' }, { placement: 'workspace' }),
  ],
}))
evaluate('loads it', { environment: env }, async (t) => {
  const turn = await t.send('x')
  expect(turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting, house-rules')).toBe(true)
  expect(await t.readFile('.agents/skills/house-rules/SKILL.md')).toContain('Be nice.')
  expect(turn.diff.files).toEqual([])
})
`,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const skills = readRun(p.dir).run.environments[0]?.skills
    assert.equal(skills?.[0]?.commit, sha)
    assert.equal(skills?.[0]?.source, `file://${repo}#v1:skills`)
    assert.deepEqual(
      skills?.map((s) => [s.name, s.placement]),
      [
        ['house-greeting', 'harness'],
        ['house-rules', 'workspace'],
      ],
    )
  })

  test("a local skill's evals/ and *.es.ts stay out of the sandbox; a block description parses", async () => {
    const p = await project('skill-hygiene', {
      'es.config.ts': fakeConfig(),
      'evals/h.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const env = defineEnvironment('reviewer', ({ skill }) => ({
  skills: [skill.local('../skills/skill-reviewer', { placement: 'workspace' })],
}))
evaluate('staged', { environment: env }, async (t) => {
  await t.send('x')
  const md = await t.readFile('.agents/skills/skill-reviewer/SKILL.md')
  expect(md).toContain(${JSON.stringify(`description: ${JSON.stringify(REVIEWER_DESCRIPTION)}`)})
  expect(md).toContain('# Skill reviewer')
  expect(await t.readFile('.agents/skills/skill-reviewer/docs/checklist.md')).toContain('# Checklist')
  const listed = (await t.exec('cd .agents/skills/skill-reviewer && find . -type f | LC_ALL=C sort')).stdout
  expect(listed.trim().split('\\n')).toEqual(['./SKILL.md', './docs/checklist.md'])
})
`,
    })
    cpSync(
      new URL('./fixtures/skill-reviewer', import.meta.url),
      join(p.dir, 'skills/skill-reviewer'),
      {
        recursive: true,
      },
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [s] = readRun(p.dir).run.environments[0]?.skills ?? []
    assert.deepEqual([s?.name, s?.excluded], ['skill-reviewer', ['evals/', 'review.es.ts']])
  })
})

describe('sandbox images', () => {
  const sandboxCases: Array<[string, string, RegExp]> = [
    [
      'two bases',
      `docker({ image: 'x:1', dockerfile: './Dockerfile' })`,
      /docker\(\) takes one base image, but got image and dockerfile\. Use image \(has the harness\), from \(a toolchain image ES bakes the harness onto\) or dockerfile\./,
    ],
    [
      'image and from',
      `docker({ image: 'x:1', from: 'python:3.12-slim' })`,
      /docker\(\) takes one base image, but got image and from\./,
    ],
    [
      'install with a dockerfile',
      `docker({ dockerfile: './Dockerfile', install: ['apt-get install -y jq'] })`,
      /docker\(\) takes dockerfile or install, not both: put the install commands in the Dockerfile as RUN lines/,
    ],
    [
      'a missing dockerfile',
      `docker({ dockerfile: './nope/Dockerfile' })`,
      /docker\(\{ dockerfile: "\.\/nope\/Dockerfile" \}\): .+\/evals\/nope\/Dockerfile doesn't exist\. Paths are relative to the file that calls docker\(\)\./,
    ],
    [
      'an empty install',
      `docker({ install: [] })`,
      /docker\(\{ install \}\) takes a non-empty list of shell commands/,
    ],
    [
      'an install command that is not a command',
      `docker({ install: [{ command: 'x' }] as never })`,
      /docker\(\{ install \}\) commands are strings or \{ run, timeout\? \} objects \(got \{"command":"x"\}\)/,
    ],
    [
      'a bad install timeout',
      `docker({ install: [{ run: 'x', timeout: 'soon' }] as never })`,
      /Invalid timeout "soon" for docker\(\{ install \}\) command "x"\. Use e\.g\. "90s" or "15m"\./,
    ],
    [
      'steps instead of install',
      `docker({ steps: ['x'] } as never)`,
      /Unknown docker\(\) option "steps"\. Did you mean "install"\?/,
    ],
    [
      'secrets on the sandbox',
      `docker({ env: {} } as never)`,
      /Unknown docker\(\) option "env"\. The sandbox is what's baked into the image; variables and secrets belong in defineEnvironment\(\{ env \}\)\./,
    ],
  ]
  for (const [what, sandbox, message] of sandboxCases) {
    test(`${what} exits 2 with a fix`, async () => {
      const p = await project('sandbox-mistake', {
        'es.config.ts': fakeConfig(),
        'evals/Dockerfile': 'FROM debian:bookworm-slim\n',
        'evals/o.es.ts': `import { evaluate } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
evaluate('e', { sandbox: ${sandbox} }, async () => {})
`,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${sandbox}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    })
  }

  test('es image build --dry-run lists every image the planned sandboxes need', async () => {
    const p = await project('image-plan', {
      'es.config.ts': `
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig({
  harness: fakeHarness({}),
  sandbox: docker({ install: ['apt-get update && apt-get install -y jq', { run: 'jq --version', timeout: '1m' }] }),
  judge: { model: fakeJudge() },
})
`,
      'docker/tools/Dockerfile': `ARG ES_BASE\nFROM \${ES_BASE}\nRUN echo tools\n`,
      'evals/py.Dockerfile': 'FROM python:3.12-slim\n',
      'evals/a.es.ts': `import { evaluate } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
evaluate('default', async () => {})
evaluate('default again', async () => {})
evaluate('tools', { sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }) }, async () => {})
evaluate('py', { sandbox: docker({ dockerfile: new URL('./py.Dockerfile', import.meta.url) }) }, async () => {})
evaluate('from', { sandbox: docker({ from: 'python:3.12-slim', maxConcurrent: 2 }) }, async () => {})
evaluate('fake', { sandbox: (await import('evalsuite/sandbox')).fakeSandbox() }, async () => {})
`,
    })
    const r = await runCli(p.dir, ['image', 'build', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout
    assert.match(out, /^images {2}4 sandbox images \(nothing built: --dry-run\)$/m)
    assert.match(
      out,
      /^docker \+ install · 2 evals\n {2}base +evalsuite-sandbox:cursor-[\d.]+ +\(rebuild: the harness bootstrap\)\n {2}install 2 commands +evalsuite-install:<base id \+ commands> +\(build unless cached\)$/m,
    )
    assert.match(
      out,
      /^docker:tools · 1 eval\n {2}dockerfile docker\/tools\/Dockerfile +evalsuite-dockerfile:tools-[0-9a-f]{16} +\(docker build \(layer cache\), tagged by content hash\)\n {2}harness +evalsuite-dockerfile:tools-[0-9a-f]{16} +\(inherited: FROM \$\{ES_BASE\}\)$/m,
    )
    assert.match(
      out,
      /^docker:py\.Dockerfile · 1 eval\n {2}dockerfile evals\/py\.Dockerfile +evalsuite-dockerfile:py-dockerfile-[0-9a-f]{16} .*\n {2}harness +evalsuite-sandbox:cursor-[\d.]+-evalsuite-dockerfile-py-dockerfile-.+ +\(rebuild: Node, git and the harness bootstrap on top\)$/m,
    )
    assert.match(
      out,
      /^docker:python:3\.12-slim · 1 eval\n {2}from python:3\.12-slim +evalsuite-sandbox:cursor-[\d.]+-python-3-12-slim-[0-9a-f]{8}/m,
    )
    assert.doesNotMatch(out, /fake/)
    const runs = join(p.dir, '.es', 'runs')
    assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, 0, 'a dry run writes no run')
  })
})
