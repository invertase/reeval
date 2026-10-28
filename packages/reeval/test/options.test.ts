import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../src/config.ts'
import { collect, collectingFile, registerGroup, registerTest } from '../src/engine/collector.ts'
import { useEngine } from '../src/engine/runtime.ts'
import { defineEnvironment } from '../src/environment.ts'
import { evaluate, group } from '../src/evaluate.ts'
import { fakeHarness } from '../src/harness.ts'
import { fakeJudge } from '../src/judge.ts'
import { fakeSandbox } from '../src/sandbox.ts'
import type { EnvironmentHelpers, RunContext } from '../src/types.ts'
import { fakeConfig, project, readRun, recordedRuns, runCli, tempDir } from './helpers.ts'
import { fixture } from './support/fixture.ts'

const config = (extra: string, harness = 'fakeHarness({})') => `
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
const sandbox = fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) })
export default defineConfig({
  harness: ${harness},
  environment: defineEnvironment('fake', { sandbox }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  ${extra}
})
`

const SKILL = `---
name: house-greeting
description: The organization's greeting style. Use when writing greetings.
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
      'reeval.config.ts': config(
        '',
        `[fakeHarness({ id: 'good', files: { 'ok.txt': 'yes' } }), fakeHarness({ id: 'bad' })]`,
      ),
      'evals/m.eval.ts': `import { evaluate, expect, group } from 'reeval'
group('g', { runs: 2 }, () => {
  evaluate('writes ok.txt', async (c) => {
    await c.send('go')
    expect(c.attempt.n).toBeGreaterThan(0)
    await expect(c).toHaveFile('ok.txt')
  })
})
`,
    })
    const r = await runCli(p.dir, ['run', '--output-logs', 'full'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^plan {2}(?:run \S+ · )?1 eval · 2 cells · 4 attempts · ~/m)
    assert.match(r.stdout, /^\[writes#1 good\] ▶ evals\/m\.eval\.ts › g › writes ok\.txt$/m)
    assert.match(r.stdout, /^\[writes#2 bad\] ▶ evals\/m\.eval\.ts › g › writes ok\.txt$/m)
    assert.match(
      r.stdout,
      /^fail {13}g › writes ok\.txt\n {2}harness {14}pass\n {2}good {17}2 of 2\n {2}bad {18}0 of 2\n {4}toHaveFile ok\.txt {2}0 of 2 {2}evals\/m\.eval\.ts:6\n/m,
    )
    assert.match(r.stdout, /^1 fail$/m)
    const thirds = await project('matrix-thirds', {
      'reeval.config.ts': config('', `fakeHarness({ id: 'one' })`),
      'evals/t.eval.ts': `import { evaluate } from 'reeval'
evaluate('two of three', { runs: 3, gate: { passRate: 0.5 } }, async (c) => {
  await c.send('go')
  if (c.attempt.n === 2) throw new Error('the second attempt fails')
})
`,
    })
    const rounded = await runCli(thirds.dir)
    assert.equal(rounded.code, 0, rounded.stdout + rounded.stderr)
    assert.match(
      rounded.stdout,
      /^pass {13}two of three\n {2}3 tries {10}2 of 3$/m,
      'counts read N of M, never a percentage',
    )
    assert.doesNotMatch(rounded.stdout, /\d%/)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.summary.attempts, 4)
    assert.deepEqual(
      run.stack.harnesses.map((h) => h.id),
      ['bad', 'good'],
    )
    assert.deepEqual(run.plan, {
      evals: 1,
      cells: 2,
      attempts: 4,
      estimateMs: run.plan.estimateMs,
      sandboxWarnings: [],
    })
    const [e] = evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.passRate, 0.5)
    assert.deepEqual(
      e?.cells.map((c) => [c.key, c.role, c.gate, c.runs, c.pass, c.passRate, c.outcome]),
      [
        ['good/fake/fake', 'control', 'all', 2, 2, 1, 'pass'],
        ['bad/fake/fake', 'control', 'all', 2, 0, 0, 'fail'],
      ],
    )
    assert.deepEqual(
      e?.attempts.map((a) => a.id),
      ['good/fake/fake#1', 'good/fake/fake#2', 'bad/fake/fake#1', 'bad/fake/fake#2'],
    )

    const narrowed = await runCli(p.dir, ['run', 'good/', '--runs', '1'])
    assert.equal(narrowed.code, 0, narrowed.stdout)
    assert.deepEqual(
      readRun(p.dir).evals[0]?.attempts.map((a) => a.id),
      ['good/fake/fake#1'],
      'a filter matches cell keys, and --runs overrides the group',
    )
  })

  test('groups replace the harness list, evals can edit it, and options may come last', async () => {
    const p = await project('cascade', {
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'evals/c.eval.ts': `import { evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
group('only c', () => {
  evaluate('replaced', async (c) => { await c.send('x') })
  evaluate('added', { harness: (h) => [...h, fakeHarness({ id: 'd' })] }, async (c) => { await c.send('x') })
}, { harness: fakeHarness({ id: 'c' }) })
evaluate('inherits', async (c) => { await c.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const cells = Object.fromEntries(
      readRun(p.dir).evals.map((e) => [e.name, e.cells.map((c) => c.harness)]),
    )
    assert.deepEqual(cells, { replaced: ['c'], added: ['c', 'd'], inherits: ['a', 'b'] })
  })

  test('harness edits as data: { add } appends to the inherited list, { only } keeps by id', async () => {
    const p = await project('harness-edits', {
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'evals/e.eval.ts': `import { evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
group('only a', { harness: { only: 'a' } }, () => {
  evaluate('kept', async (c) => { await c.send('x') })
  evaluate('added', { harness: { add: [fakeHarness({ id: 'd' })] } }, async (c) => { await c.send('x') })
})
evaluate('kept both', { harness: { only: ['b', 'a'] } }, async (c) => { await c.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const cells = Object.fromEntries(
      readRun(p.dir).evals.map((e) => [e.name, e.cells.map((c) => c.harness)]),
    )
    assert.deepEqual(cells, { kept: ['a'], added: ['a', 'd'], 'kept both': ['a', 'b'] })
  })

  test('tags filter, todo, for, and a filter that matches nothing exits 2', async () => {
    const p = await project('tags', {
      'reeval.config.ts': fakeConfig(),
      'evals/t.eval.ts': `import { evaluate, group } from 'reeval'
group('slow things', { tags: ['slow'] }, () => {
  evaluate('big', async () => {})
  evaluate('bigger', { tags: ['flaky'] }, async () => {})
})
evaluate('quick', async () => {})
evaluate.todo('later')
evaluate.each([{ a: 1, b: 2 }, { a: 3, b: 4 }])('adds $a and $b (%#)', async (c, { a, b }) => {
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
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { evaluate } from 'reeval'
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
    assert.match(ci.stderr, /evaluate\.only\/group\.only in evals\/o\.eval\.ts isn't allowed in CI/)
    assert.equal(readRun(p.dir).run.runId, runId, 'no run written for a usage error')
    assert.deepEqual(readdirSync(join(p.dir, '.reeval/staging')), [], 'no staging left behind')

    const groupOnly = await project('group-only', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { evaluate, group } from 'reeval'
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

  test('c.judge without a model names where to set one', async () => {
    const p = await project('no-judge', {
      'reeval.config.ts': config('').replace('judge: { model: fakeJudge({ score: 0.9 }) },', ''),
      'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('judged', async (c) => {
  await c.send('x')
  expect(await c.judge('ok?', { diff: true })).toPass()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /c\.judge\(\) has no model\. Set judge: \{ model: 'typesafe-ai\/jev-1\.14\.0' \} in reeval\.config\.ts/,
    )
    assert.equal(readRun(p.dir).evals[0]?.error?.kind, 'judge')
  })
})

describe('compare', () => {
  const envs = `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const base = defineEnvironment('base', { sandbox, env: { MODE: 'base' } })
export const skilled = base.extendEnvironment('skilled', ({ skill }) => ({
  env: { MODE: 'skilled' },
  skills: [skill.local('../skills')],
}))
`

  const each = (
    options: string,
    runs = 1,
    cases = "['ada', 'grace', 'linus', 'margaret', 'dennis', 'barbara']",
  ) => ({
    'reeval.config.ts': config('', SKILLED),
    'skills/house-greeting/SKILL.md': SKILL,
    'evals/envs.ts': envs,
    'evals/e.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate.each(${cases}${options})(
  'writes ok.txt for %s',
  { compare: { baseline: base, variants: [skilled], minLift: MIN_LIFT }, runs: ${runs} },
  async (c, name) => {
    await c.send('write ok.txt for ' + name)
    await expect(c).toHaveFile('ok.txt')
  },
)
`,
  })

  test('evaluate.each pools its cases into one paired lift that minLift gates', async () => {
    const files = each('')
    const p = await project('each-pooled', {
      ...files,
      'evals/e.eval.ts': files['evals/e.eval.ts'].replace('MIN_LIFT', '0.2'),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    // The case is outer and its arms inner; the pooled effect is on `all cases`.
    assert.match(
      r.stdout,
      /^ {17}writes ok\.txt for %s\n {2}pass {2}ada\n {4}arm {12}pass\n {4}base {11}0 of 1\n {4}skilled {8}1 of 1\n/m,
    )
    for (const name of ['grace', 'linus', 'margaret', 'dennis', 'barbara'])
      assert.match(r.stdout, new RegExp(`^ {2}pass {2}${name}$`, 'm'), name)
    const pooled =
      /^ {2}pass {2}all cases\n {4}arm {12}pass\n {4}base {11}0 of 6\n {4}skilled {8}6 of 6 {2}helped$/m
    assert.match(r.stdout, pooled)
    assert.match(r.stdout, /^6 pass$/m)
    const verbose = await runCli(p.dir, ['run', '-v'])
    assert.match(verbose.stdout, /^ {6}skilled: 6 paired cases, 95% interval \+45…\+100$/m)
    assert.doesNotMatch(r.stdout, /95% interval/, 'statistics only with -v')

    const { run, evals, read } = readRun(p.dir)
    assert.deepEqual(
      evals.map((e) => [e.name, e.family?.case]),
      ['ada', 'grace', 'linus', 'margaret', 'dennis', 'barbara'].map((n, i) => [
        `writes ok.txt for ${n}`,
        i,
      ]),
    )
    assert.ok(
      evals.every((e) => e.cells.every((c) => c.lift?.minLift === undefined)),
      'a case is not gated on minLift alone',
    )
    const [family] = run.families ?? []
    assert.equal(family?.id, 'evals/e.eval.ts › writes ok.txt for %s')
    assert.deepEqual(
      family?.rates.map((x) => [x.cell, x.pass, x.counted, x.interval.method]),
      [
        ['fake/base/fake', 0, 6, 'wilson'],
        ['fake/skilled/fake', 6, 6, 'wilson'],
      ],
    )
    const lift = family?.lifts[0]
    assert.deepEqual(
      [
        lift?.vs,
        lift?.pairs,
        lift?.discordant,
        lift?.interval.method,
        lift?.verdict,
        lift?.outcome,
      ],
      ['fake/base/fake', 6, { variantOnly: 6, controlOnly: 0 }, 'newcombe-paired', 'lift', 'pass'],
    )
    assert.equal(family?.outcome, 'pass')
    assert.match(read('summary.md'), pooled)

    const agent = await runCli(p.dir, ['run', '--ui', 'agent'])
    assert.equal(agent.code, 0, agent.stdout + agent.stderr)
    assert.match(agent.stdout, pooled)

    const q = await runCli(p.dir, [
      'query',
      'select family_id, variant, pairs, variant_pass_at_1, control_pass_at_1, verdict, outcome from family_lift',
      '--json',
    ])
    assert.equal(q.code, 0, q.stdout + q.stderr)
    assert.deepEqual(JSON.parse(q.stdout)[0], {
      family_id: 'evals/e.eval.ts › writes ok.txt for %s',
      variant: 'skilled',
      pairs: 6,
      variant_pass_at_1: 1,
      control_pass_at_1: 0,
      verdict: 'lift',
      outcome: 'pass',
    })
    const rates = await runCli(p.dir, [
      'query',
      'select cell_key, pass, counted, pass_at_1 from families where run_id = (select max(run_id) from runs) order by cell_key',
      '--json',
    ])
    assert.equal(rates.code, 0, rates.stdout + rates.stderr)
    assert.deepEqual(JSON.parse(rates.stdout), [
      { cell_key: 'fake/base/fake', pass: 0, counted: 6, pass_at_1: 0 },
      { cell_key: 'fake/skilled/fake', pass: 6, counted: 6, pass_at_1: 1 },
    ])
  })

  test("a pooled lift below minLift fails the run, and the family's mark", async () => {
    const files = each('')
    const p = await project('each-min-lift', {
      ...files,
      'evals/e.eval.ts': files['evals/e.eval.ts'].replace('MIN_LIFT', '0.6'),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^ {2}fail {2}all cases\n {4}arm {12}pass\n {4}base {11}0 of 6\n {4}skilled {8}6 of 6 {2}helped, not by minLift 60$/m,
    )
    assert.match(r.stdout, /^ {2}pass {2}ada$/m, 'the case passed on its own')
    assert.match(r.stdout, /^1 fail · 6 pass$/m, 'the pooled gate is a fail of its own')
    const { run, evals } = readRun(p.dir)
    assert.equal(run.families?.[0]?.outcome, 'fail')
    assert.ok(
      evals.every((e) => e.outcome === 'pass'),
      'every case passed on its own',
    )
  })

  test('evaluate.each with { pool: false } records independent evals', async () => {
    const files = each(', { pool: false }')
    const p = await project('each-unpooled', {
      ...files,
      'evals/e.eval.ts': files['evals/e.eval.ts'].replace(', minLift: MIN_LIFT', ''),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /all cases|writes ok\.txt for %s/)
    assert.match(r.stdout, /^pass {13}writes ok\.txt for ada$/m)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.families, undefined)
    assert.equal(evals.length, 6)
    assert.ok(evals.every((e) => e.family === undefined))
  })

  test('a pooled family over several runs a case pairs per-case pass rates', async () => {
    const files = each('', 2, "['ada', 'grace', 'linus']")
    const p = await project('each-runs', {
      ...files,
      'evals/e.eval.ts': files['evals/e.eval.ts'].replace('MIN_LIFT', '0.2'),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const lift = readRun(p.dir).run.families?.[0]?.lifts[0]
    assert.deepEqual(
      [lift?.pairs, lift?.points, lift?.interval.method, lift?.verdict, lift?.outcome],
      [3, 1, 't-cases', 'insufficient', 'pass'],
    )
    // Three pairs are too few to tell, however one-sided they are.
    assert.match(r.stdout, /^ {4}skilled {8}6 of 6 {2}can't tell yet$/m)
  })

  test('variants run next to the control, lift is stored, and the control is not gated', async () => {
    const p = await project('compare', {
      'reeval.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate, expect, group } from 'reeval'
import { base, skilled } from './envs.ts'
group('g', { compare: { baseline: base, variants: [skilled] }, runs: 2 }, () => {
  evaluate('writes ok.txt', async (c) => {
    await c.send('go')
    const mode = (await c.exec('printf %s "$MODE"')).stdout
    expect(mode).toBe(c.attempt.cell.role === 'control' ? 'base' : 'skilled')
    await expect(c).toHaveFile('ok.txt')
  })
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^plan {2}(?:run \S+ · )?1 eval · 2 cells · 4 attempts/m)
    // A successful compare reads as one: the control's expected misses aren't failures.
    const block =
      /^pass {13}g › writes ok\.txt\n {2}arm {16}pass\n {2}base {15}0 of 2\n {2}skilled {12}2 of 2 {2}can't tell yet\n {2}check {14}base {5}skilled\n {2}toBe base {10}2 of 2 {3}not run\n {2}toHaveFile ok\.txt {2}0 of 2 {3}2 of 2\n/m
    assert.match(r.stdout, block)
    assert.match(r.stdout, /^1 pass$/m)

    const color = await runCli(p.dir, ['run'], { env: { FORCE_COLOR: '1' } })
    assert.equal(color.code, 0, color.stdout + color.stderr)
    assert.ok(!color.stdout.includes('\x1b[31m'), 'nothing red')

    const agent = await runCli(p.dir, ['run', '--ui', 'agent'])
    assert.equal(agent.code, 0, agent.stdout + agent.stderr)
    assert.match(agent.stdout, block)

    const gha = await runCli(p.dir, ['run', '--log-order', 'grouped', '--output-logs', 'full'], {
      env: { GITHUB_ACTIONS: 'true' },
    })
    assert.equal(gha.code, 0, gha.stdout + gha.stderr)
    assert.doesNotMatch(gha.stdout, /^::error/m)
    assert.equal(gha.stdout.match(/^::group::/gm)?.length, 4, 'expected misses collapse too')

    const md = readRun(p.dir).read('summary.md')
    assert.match(md, block)
    assert.match(md, /^#### ○ fake\/base\/fake#1 · missed, not gated$/m)
    assert.match(md, /^<details><summary>Why it missed<\/summary>$/m)
    const { run, evals } = readRun(p.dir)
    const [e] = evals
    assert.equal(e?.outcome, 'pass', 'the ungated control fails without failing the eval')
    assert.equal(e?.compare?.baseline, 'base')
    assert.equal(run.summary.notGated, 2)
    const [control, variant] = e?.cells ?? []
    assert.deepEqual(
      [control?.role, control?.gate, variant?.role, variant?.variant, variant?.gate],
      ['control', 'none', 'variant', 'skilled', 'all'],
    )
    // 2/2 against 0/2: Newcombe's interval from the Wilson bounds [0.342, 1] and [0, 0.658].
    assert.deepEqual(variant?.lift, {
      vs: 'fake/base/fake',
      control: { pass: 0, counted: 2 },
      variant: { pass: 2, counted: 2 },
      points: 1,
      interval: { lo: 0.07, hi: 1, level: 0.95, method: 'newcombe-wilson' },
      withinNoise: false,
    })
    assert.deepEqual(variant?.overrides, ['env.MODE'])
    const envRecords = Object.fromEntries(run.environments.map((x) => [x.name, x]))
    assert.equal(envRecords.skilled?.parent, 'base')
    assert.deepEqual(envRecords.skilled?.overrides, ['env.MODE'])
    assert.deepEqual(
      envRecords.skilled?.skills.map((s) => [s.name, s.source, s.placement]),
      [['house-greeting', 'local:skills', 'harness']],
    )
    assert.match(readRun(p.dir).read('summary.md'), block)
  })

  test("gate 'all' gates the control, and minLift fails a variant cell below it", async () => {
    const p = await project('compare-gates', {
      'reeval.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('all gated', { runs: 1, compare: { baseline: base, variants: [skilled], gate: 'all' } }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
evaluate('no worse', { runs: 1, compare: { baseline: base, variants: [skilled], minLift: 0.5, gate: 'none' } }, async (c) => {
  await c.send('go')
  if (c.attempt.cell.role === 'variant') throw new Error('the variant is worse')
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [all, noWorse] = readRun(p.dir).evals
    assert.equal(all?.outcome, 'fail', 'a gated control fails the eval')
    assert.equal(all?.cells[0]?.gate, 'all')
    assert.equal(noWorse?.cells[1]?.lift?.points, -1)
    assert.equal(noWorse?.cells[1]?.outcome, 'fail')
    assert.equal(noWorse?.outcome, 'pass', "gate 'none' reports but never fails")
    // The canary: a gated control's failure is still a failure; only the ungated miss moves.
    assert.match(
      r.stdout,
      /^fail {13}all gated\n {2}arm {16}pass\n {2}base {15}0 of 1\n {2}skilled {12}1 of 1 {2}can't tell yet\n {2}check {14}base {4}skilled\n {2}toHaveFile ok\.txt {2}0 of 1 {2}1 of 1\n/m,
    )
    assert.match(
      r.stdout,
      /^not gated {8}no worse\n {2}arm {14}pass\n {2}base {13}1 of 1\n {2}skilled {10}0 of 1 {2}can't tell yet, not by minLift 50\n {4}error {2}the variant is worse$/m,
    )
    assert.match(r.stdout, /^1 fail · 1 not gated$/m)
  })

  test('compare.harness scopes variants; other harnesses run the control only', async () => {
    const p = await project('compare-scope', {
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('scoped', { compare: { baseline: base, variants: [skilled], harness: ['b'] } }, async (c) => { await c.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(
      readRun(p.dir).evals[0]?.cells.map((c) => c.key),
      ['a/base/fake', 'b/base/fake', 'b/skilled/fake'],
    )
  })
})

// Which evals, cells and attempts a profile plans is pinned by the plan snapshots in
// plan.test.ts (test/plan/profiles); these check what a run does with that plan.
describe('gate policies', () => {
  // One attempt in five fails, always the third: a steady 80% agent.
  const flaky = (name: string, options: string) =>
    `evaluate('${name}', { runs: 5${options} }, async (c) => {
  if (c.attempt.n === 3) throw new Error('the third attempt fails')
})`

  test("'all' by default, { passRate } per eval or group, with a hint when runs > 1 and no gate", async () => {
    const p = await project('gates', {
      'reeval.config.ts': fakeConfig(),
      'evals/g.eval.ts': `import { evaluate, group } from 'reeval'
${flaky('default', '')}
${flaky('at 0.8', ', gate: { passRate: 0.8 }')}
${flaky('at 0.9', ', gate: { passRate: 0.9 }')}
group('rated', { gate: { passRate: 0.6 } }, () => {
  ${flaky('inherits 0.6', '')}
  ${flaky('back to all', ", gate: 'all'")}
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^hint: 1 eval runs more than once with the default gate, so every attempt must pass \(pass\^k\); set gate: \{ passRate: 0\.8 \} to gate on pass@1 instead$/m,
    )
    const cells = readRun(p.dir).evals.map((e) => [
      e.name,
      e.cells[0]?.gate,
      e.cells[0]?.passRate,
      e.cells[0]?.outcome,
      e.outcome,
    ])
    assert.deepEqual(cells, [
      ['default', 'all', 0.8, 'fail', 'fail'],
      ['at 0.8', { passRate: 0.8 }, 0.8, 'pass', 'pass'],
      ['at 0.9', { passRate: 0.9 }, 0.8, 'fail', 'fail'],
      ['inherits 0.6', { passRate: 0.6 }, 0.8, 'pass', 'pass'],
      ['back to all', 'all', 0.8, 'fail', 'fail'],
    ])
    assert.match(
      r.stdout,
      /^fail {13}default\n {2}5 tries {10}4 of 5\n {2}error {12}the third attempt fails$/m,
    )
    assert.match(r.stdout, /^pass {13}at 0\.8\n {2}5 tries {10}4 of 5$/m)
    assert.match(r.stdout, /^3 fail · 2 pass$/m)

    const quiet = await runCli(p.dir, ['run', 'at 0.8'])
    assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr)
    assert.doesNotMatch(quiet.stdout, /^hint:/m, 'no hint when every eval that repeats has a gate')
  })

  test('a config-level gate applies to every eval', async () => {
    const p = await project('config-gate', {
      'reeval.config.ts': fakeConfig({ extra: 'gate: { passRate: 0.8 },' }),
      'evals/g.eval.ts': `import { evaluate } from 'reeval'\n${flaky('steady', '')}\n`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(readRun(p.dir).evals[0]?.cells[0]?.gate, { passRate: 0.8 })
  })
})

describe('profiles', () => {
  test('a plan over budget.attempts exits 2 unless --force; the text --dry-run shows it', async () => {
    const p = await fixture('plan/profiles')
    const r = await runCli(p.dir, ['run', '--dry-run'], { env: { CI: 'true' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^plan {2}(?:run \S+ · )?profile pr \(auto: CI is set\) · 3 evals \(1 skipped\) · 4 cells · 6 attempts · ~.* · budget 5 attempts ✗$/m,
    )
    assert.match(r.stdout, /^eval +harnesses +variants +runs +attempts +notes$/m)
    assert.equal(existsSync(join(p.dir, '.reeval/runs')), false, 'a dry run writes no run')

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

  test("a profile's judge needs its own key, and a malformed one exits 2", async () => {
    const p = await project('profile-judge-key', {
      'reeval.config.ts': fakeConfig({
        extra: `profiles: { real: { judge: { model: 'google/gemini-3.8-flash' } } },`,
      }),
      'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('judged', async (c) => {
  await c.send('x')
  expect(await c.judge('Did it?', { diff: true })).toPass()
})
`,
    })
    const noKeys = {
      GOOGLE_GENERATIVE_AI_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      VERCEL_OIDC_TOKEN: '',
    }
    const canary = await runCli(p.dir, ['run'], { env: noKeys })
    assert.equal(canary.code, 0, "the config's fake judge needs no key")
    const missing = await runCli(p.dir, ['run', '--profile', 'real'], { env: noKeys })
    assert.equal(missing.code, 2, missing.stdout + missing.stderr)
    assert.match(
      missing.stderr,
      /Missing credentials: GOOGLE_GENERATIVE_AI_API_KEY \(for direct\(\)\) for the judge model, "google\/gemini-3\.8-flash"\./,
    )
    const malformed = await runCli(p.dir, ['run', '--profile', 'real'], {
      env: { ...noKeys, GOOGLE_GENERATIVE_AI_API_KEY: 'AIza\nrest' },
    })
    assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr)
    assert.match(
      malformed.stderr,
      /Credentials with whitespace or a line break in them: GOOGLE_GENERATIVE_AI_API_KEY \(character 5\)/,
    )
  })

  test("a group's or eval's judge needs its key before any attempt, and a malformed one exits 2", async () => {
    const p = await project('eval-judge-key', {
      'reeval.config.ts': `import { direct, vercel } from 'reeval/gateway'${fakeConfig({
        extra: `gateway: [direct(), vercel()],`,
      })}`,
      'evals/j.eval.ts': `import { evaluate, expect, group } from 'reeval'
evaluate('own judge', { judge: { model: 'anthropic/claude-sonnet-5' } }, async (c) => {
  await c.send('x')
  expect(await c.judge('Did it?', { diff: true })).toPass()
})
group('judged', { judge: { model: 'openai/gpt-6-luna', gateway: 'vercel' } }, () => {
  evaluate('group judge', async (c) => {
    await c.send('x')
    expect(await c.judge('Did it?', { diff: true })).toPass()
  })
})
`,
    })
    const noKeys = {
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      VERCEL_OIDC_TOKEN: '',
    }
    const missing = await runCli(p.dir, ['run'], { env: noKeys })
    assert.equal(missing.code, 2, missing.stdout + missing.stderr)
    assert.match(
      missing.stderr,
      /Missing credentials: ANTHROPIC_API_KEY \(for direct\(\)\) for the judge model, "anthropic\/claude-sonnet-5"; AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN \(for vercel\(\)\) for the judge model, "openai\/gpt-6-luna"\./,
    )
    assert.doesNotMatch(missing.stdout, /own judge|group judge/, 'no attempt started')
    const malformed = await runCli(p.dir, ['run'], {
      env: { ...noKeys, ANTHROPIC_API_KEY: 'sk-ant\nrest', AI_GATEWAY_API_KEY: 'vck test' },
    })
    assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr)
    assert.match(
      malformed.stderr,
      /Credentials with whitespace or a line break in them: ANTHROPIC_API_KEY \(character 7\), AI_GATEWAY_API_KEY \(character 4\)/,
    )
    const narrowed = await runCli(p.dir, ['run', 'own judge'], { env: noKeys })
    assert.equal(narrowed.code, 2, narrowed.stdout + narrowed.stderr)
    assert.match(narrowed.stderr, /Missing credentials: ANTHROPIC_API_KEY \(for direct\(\)\)/)
    assert.doesNotMatch(narrowed.stderr, /AI_GATEWAY_API_KEY/, 'a filtered-out eval needs no key')
  })

  const judgeKeyCases: Array<[string, string, RegExp]> = [
    [
      'anthropic/claude-sonnet-5',
      'ANTHROPIC_API_KEY',
      /Missing credentials: ANTHROPIC_API_KEY \(for direct\(\)\) for the judge model, "anthropic\/claude-sonnet-5"\. Set them in the environment or \.env\.local\.$/m,
    ],
    [
      'openai/gpt-6-luna',
      'OPENAI_API_KEY',
      /Missing credentials: OPENAI_API_KEY \(for direct\(\)\) for the judge model, "openai\/gpt-6-luna"\./,
    ],
    [
      'mistral/mistral-large',
      'AI_GATEWAY_API_KEY',
      /the judge model "mistral\/mistral-large": no gateway in the list can serve it \(direct: reeval calls only anthropic\/\*, google\/\*, openai\/\*, typesafe-ai\/\* models on their own keys\)\. Add vercel\(\) to gateway\./,
    ],
  ]
  test('a judge model without its key exits 2 naming the keys that work, before any attempt', async () => {
    const noKeys = {
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      VERCEL_OIDC_TOKEN: '',
    }
    for (const [model, key, message] of judgeKeyCases) {
      const p = await project('judge-key', {
        'reeval.config.ts': fakeConfig({
          extra: `profiles: { real: { judge: { model: '${model}' } } },`,
        }),
        'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('judged', async (c) => {
  await c.send('x')
  expect(await c.judge('Did it?', { diff: true })).toPass()
})
`,
      })
      const missing = await runCli(p.dir, ['run', '--profile', 'real'], { env: noKeys })
      assert.equal(missing.code, 2, missing.stdout + missing.stderr)
      assert.match(missing.stderr, message)
      if (key === 'AI_GATEWAY_API_KEY') continue
      const unused = await runCli(p.dir, ['run', '--profile', 'real'], {
        env: { ...noKeys, AI_GATEWAY_API_KEY: 'vck_test' },
      })
      assert.equal(unused.code, 2, 'no gateway by default: the Gateway key never stands in')
      assert.match(
        unused.stderr,
        /Set them in the environment or \.env\.local\. AI_GATEWAY_API_KEY is set, but no gateway in the config uses it: add vercel\(\) to gateway to call the model through Vercel AI Gateway\./,
      )
      const malformed = await runCli(p.dir, ['run', '--profile', 'real'], {
        env: { ...noKeys, [key]: 'sk-test\nrest' },
      })
      assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr)
      assert.match(
        malformed.stderr,
        new RegExp(`Credentials with whitespace or a line break in them: ${key} \\(character 8\\)`),
      )
    }
  })

  test('a profile name typo exits 2 and lists the profiles', async () => {
    const p = await fixture('plan/profiles')
    const typo = await runCli(p.dir, ['run', '--profile', 'nigthly'])
    assert.equal(typo.code, 2)
    assert.match(
      typo.stderr,
      /reeval: Unknown profile "nigthly"\. Profiles in reeval\.config\.ts: pr, nightly\./,
    )
  })

  test('a profile limit.harness id no collected eval runs on exits 2, naming the ids they do', async () => {
    const p = await project('limit-harness-unknown', {
      'reeval.config.ts': config(
        `profiles: {
    typo: { limit: { harness: ['cursor'] } },
    one: { limit: { harness: ['a:x', 'cursor'] } },
    tagged: { limit: { harness: ['b:y'] } },
    both: { limit: { harness: ['a:x', 'c:z'] } },
    other: { limit: { harness: ['c:z'] } },
  },`,
        "fakeHarness({ id: 'a:x' })",
      ),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'
evaluate('plain', async () => {})
evaluate('slow', { tags: ['slow'], harness: fakeHarness({ id: 'b:y' }) }, async () => {})
`,
      'evals/c.eval.ts': `import { evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'
evaluate('other', { harness: fakeHarness({ id: 'c:z' }) }, async () => {})
`,
    })
    const refused = (ids: string) =>
      new RegExp(
        `reeval: profiles\\.\\w+\\.limit\\.harness in reeval\\.config\\.ts lists ${ids}, which no eval runs on\\. Harness ids the evals run on: a:x, b:y, c:z\\.`,
      )
    for (const args of [['--dry-run'], []]) {
      const r = await runCli(p.dir, ['run', '--profile', 'typo', ...args])
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, refused('"cursor"'))
    }
    assert.equal(existsSync(join(p.dir, '.reeval', 'runs')), false, 'nothing ran or recorded')
    const one = await runCli(p.dir, ['run', '--dry-run', '--profile', 'one'])
    assert.equal(one.code, 2, one.stdout + one.stderr)
    assert.match(one.stderr, refused('"cursor"'))
    // An eval the tags leave out still names its harnesses.
    const tagged = await runCli(p.dir, [
      'run',
      '--dry-run',
      '--profile',
      'tagged',
      '--tag',
      '!slow',
    ])
    assert.equal(tagged.code, 0, tagged.stdout + tagged.stderr)
    // A path filter leaves the other file's harnesses unknown: an id that matches none of the
    // loaded files' is accepted while another matches, refused when none does.
    const narrowed = await runCli(p.dir, [
      'run',
      '--dry-run',
      '--profile',
      'both',
      'evals/a.eval.ts',
    ])
    assert.equal(narrowed.code, 0, narrowed.stdout + narrowed.stderr)
    const none = await runCli(p.dir, ['run', '--dry-run', '--profile', 'other', 'evals/a.eval.ts'])
    assert.equal(none.code, 2, none.stdout + none.stderr)
    assert.match(
      none.stderr,
      /lists "c:z", which no eval in the selected files runs on\. Harness ids the evals in the selected files run on: a:x, b:y\./,
    )
  })

  test('budget.duration stops new attempts; the run is marked budget and exits 1', async () => {
    const p = await project('budget-duration', {
      'reeval.config.ts': config(
        `concurrency: 1, budget: { duration: '1s' },`,
        'fakeHarness({ delayMs: 700 })',
      ),
      'evals/b.eval.ts': `import { evaluate } from 'reeval'
evaluate('slow', { runs: 4 }, async (c) => { await c.send('x') })
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
    assert.deepEqual(recordedRuns(p.dir), [], 'not recorded without --record or record: always')

    // With --record, it's recorded as status budget (compare only takes complete runs as a base).
    const recorded = await runCli(p.dir, ['run', '--record'])
    assert.equal(recorded.code, 1, recorded.stdout + recorded.stderr)
    assert.match(recorded.stdout, /^recorded evals\/\.history\/\S+\.json/m)
    const history = readRun(p.dir, { history: 'evals/.history' })
    assert.equal(history.run.status, 'budget')
  })

  test('a budget-stopped run is auto-recorded in CI and by record: always, with status budget, and is never a compare base', async () => {
    const files = (record: string) => ({
      'reeval.config.ts': config(
        `concurrency: 1, budget: { duration: '1s' },${record}`,
        'fakeHarness({ delayMs: 1500 })',
      ),
      'evals/b.eval.ts': `import { evaluate } from 'reeval'
evaluate('slow', { runs: 4 }, async (c) => { await c.send('x') })
`,
    })
    const ci = await project('budget-record-ci', files(''))
    const inCI = await runCli(ci.dir, ['run'], { env: { CI: '1' } })
    assert.equal(inCI.code, 1, inCI.stdout + inCI.stderr)
    assert.match(inCI.stdout, /^recorded evals\/\.history\/\S+\.json/m)
    assert.equal(readRun(ci.dir, { history: 'evals/.history' }).run.status, 'budget')
    const compared = await runCli(ci.dir, ['compare', '--json'])
    assert.equal(JSON.parse(compared.stdout).base, null, 'a budget run is never the base')

    const always = await project('budget-record-always', files(` record: 'always',`))
    assert.equal((await runCli(always.dir)).code, 1)
    const [runId] = recordedRuns(always.dir)
    assert.ok(runId, 'recorded by record: always')
    assert.equal(readRun(always.dir, { history: 'evals/.history' }).run.status, 'budget')

    // Canary: record: 'manual' leaves it to reeval record, which refuses it without --allow-incomplete.
    const manual = await project('budget-record-manual', files(` record: 'manual',`))
    assert.equal((await runCli(manual.dir, ['run'], { env: { CI: '1' } })).code, 1)
    assert.deepEqual(recordedRuns(manual.dir), [])
    const refused = await runCli(manual.dir, ['record', 'latest'])
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.equal((await runCli(manual.dir, ['record', 'latest', '--allow-incomplete'])).code, 0)
    assert.equal(readRun(manual.dir, { history: 'evals/.history' }).run.status, 'budget')
  })
})

describe('common mistakes', { concurrency: 4 }, () => {
  describe('refused in-process', () => {
    // Each refusal here happens while reeval collects the eval file or resolves the config, so the
    // rows run that in-process, as a worker does; test/refusals/ holds the contract's own checks
    // to golden messages, and the CLI rows below hold the wiring: exit 2 and the message printed.
    const root = tempDir('mistakes')
    const a = defineEnvironment('a', {})
    const b = defineEnvironment('b', {})
    const fakeConfigInput = (environment = true) => ({
      harness: fakeHarness({}),
      sandbox: fakeSandbox({ dir: join(root, 'sandboxes') }),
      ...(environment ? { environment: defineEnvironment('fake', {}) } : {}),
      judge: { model: fakeJudge({ score: 0.9 }) },
    })
    let files = 0

    /**
     * What collecting an eval file that runs `declare` refuses, under `fakeConfig()`'s config, or
     * `null` when it plans.
     */
    async function refusal(
      declare: () => void,
      config = fakeConfigInput(),
    ): Promise<string | null> {
      const run: RunContext = {
        runId: 'r',
        stagingDir: root,
        config: resolveConfig(config, root),
        tags: [],
        concurrency: 1,
        profile: null,
      }
      useEngine({
        registerTest,
        registerGroup,
        getRunContext: () => run,
        collectingFile,
        declareHarnesses: () => {},
      })
      const file = join(root, `evals/m${++files}.eval.ts`)
      try {
        await collect(file, async () => declare())
      } catch (error) {
        return (error as Error).message
      }
      return null
    }

    const cases: Array<[string, () => unknown, RegExp]> = [
      [
        'a question that shows the model nothing',
        () =>
          group('g', { question: { model: 'google/gemini-3.8-flash' } }, () => {
            evaluate(
              'e',
              { questions: [{ question: 'Q', diff: false, output: false, transcript: false }] },
              async () => {},
            )
          }),
        /questions "Q" in evaluate\("g › e"\) shows the model nothing: turn on at least one of task, output, files, diff, transcript, checks or artifacts, e\.g\. \{ question: '…', diff: true \}\./,
      ],
      [
        'a variant with its own checks',
        () =>
          evaluate(
            'e',
            { compare: { baseline: a, variants: [{ environment: a, check: () => {} } as never] } },
            async () => {},
          ),
        /compare\.variants in evaluate\("e"\) must be environments from defineEnvironment \(got an object with "environment", "check"\)\. Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval\./,
      ],
      [
        'compare scoped to a harness the eval does not run',
        () =>
          evaluate(
            'e',
            { compare: { baseline: b, variants: [a], harness: ['sonnet'] } },
            async () => {},
          ),
        /compare\.harness lists sonnet, which evaluate\("e"\) doesn't run \(it runs fake\)\./,
      ],
      [
        'compare arms whose refs come from unset variables',
        () => {
          const base = defineEnvironment('base', ({ git }) => ({
            workspace: git('..', { ref: process.env.REEVAL_TEST_UNSET_BASE }),
          }))
          const head = base.extendEnvironment('head', ({ git }) => ({
            workspace: git('..', { ref: process.env.REEVAL_TEST_UNSET_HEAD }),
          }))
          evaluate('e', { compare: { baseline: base, variants: [head] } }, async () => {})
        },
        /compare in evaluate\("e"\) runs head and base on the same tree: past what they share, each sets only workspace, and both are git\("\.\."\) with no ref \(the repository HEAD\)\. A ref read from an unset variable is undefined, so check the variables the arms take their refs from, and give each arm its own ref\./,
      ],
      [
        'a variant that is the environment a compare without a baseline runs as its control',
        () =>
          group('g', { environment: a }, () => {
            evaluate('e', { compare: { variants: [a, b] } }, async () => {})
          }),
        /compare in evaluate\("g › e"\) lists a, which is the control: compare has no baseline, so the eval's environment is\./,
      ],
      [
        'a pairwise question across environments without a compare',
        () =>
          evaluate(
            'e',
            { questions: [{ question: 'Which?', across: 'environment', diff: true }] },
            async () => {},
          ),
        /questions "Which\?" in evaluate\("e"\) varies the environment \(across: 'environment'\), but evaluate\("e"\) runs one environment, so it has no pairs to ask\. Add compare: \{ variants: \[\.\.\.\] \}, or leave out across to ask each attempt on its own\./,
      ],
      [
        'a pairwise question across harnesses on one harness',
        () =>
          evaluate(
            'e',
            {
              compare: { baseline: a, variants: [b] },
              questions: [{ question: 'Which?', across: ['environment', 'harness'], diff: true }],
            },
            async () => {},
          ),
        /questions "Which\?" in evaluate\("e"\) varies the harness \(across: 'harness'\), but evaluate\("e"\) runs one harness \(fake\), so it has no pairs to ask\. Run it on two or more, harness: \[a, b\], or leave out across to ask each attempt on its own\./,
      ],
      [
        'pinning something that cannot be pinned',
        () => evaluate('e', { pin: ['timeout'] as never }, async () => {}),
        /pin in evaluate\("e"\) lists harness, runs and\/or compare \(got "timeout"\)/,
      ],
      [
        'a callback as group options',
        () =>
          group(
            'genkit',
            (({ secret }: { secret: { fromEnv: (k: string) => unknown } }) => ({
              env: { KEY: secret.fromEnv('KEY') },
            })) as never,
            () => {},
          ),
        /group\("genkit"\) got two functions\. Options must be a plain object; helpers such as secret are only available in defineConfig and defineEnvironment callbacks\./,
      ],
      [
        'a harness edit naming a harness the eval does not inherit',
        () => evaluate('e', { harness: { only: 'cursor' } }, async () => {}),
        /harness \{ only: "cursor" \} in evaluate\("e"\) names no inherited harness \(inherited: fake\)/,
      ],
      [
        'a harness edit that adds and keeps at once',
        () => evaluate('e', { harness: { add: [], only: 'fake' } as never }, async () => {}),
        /harness in evaluate\("e"\) takes \{ add \} or \{ only \}, not both\. Use add/,
      ],
      [
        'an old option name',
        () => group('g', { harnesses: [] } as never, () => {}),
        /Unknown option "harnesses" in group\("g"\)\. Did you mean "harness"\?/,
      ],
      [
        'repeat instead of runs',
        () => evaluate('e', { repeat: 3 } as never, async () => {}),
        /Unknown option "repeat" .*Did you mean "runs"\?/,
      ],
      [
        'an eval with no function',
        () => (evaluate as (name: string, options: object) => void)('x', {}),
        /evaluate\("x"\) has no function\. Pass the eval's body, e\.g\. evaluate\("x", async \(c\) => \{ … \}\)\./,
      ],
      [
        'evaluate.each cases with the same name',
        () =>
          evaluate.each([
            { a: 1, b: 2 },
            { a: 1, b: 3 },
          ])('adds $a', async () => {}),
        /evaluate\("adds 1"\) is declared twice in this file\. .* For evaluate\.each, put \$key, %s or %# in the name \("adds \$a"\) so each case's name differs\./,
      ],
      [
        "pool in an eval's options",
        () => evaluate.each([1, 2])('n %s', { pool: false } as never, async () => {}),
        /Unknown option "pool" in evaluate\("n 1"\)\. pool is an option of evaluate\.each, beside the cases: evaluate\.each\(cases, \{ pool: false \}\)\./,
      ],
      [
        "eval options as evaluate.each's second argument",
        () => evaluate.each([1, 2], { runs: 2 } as never)('n %s', async () => {}),
        /evaluate\.each\(cases, options\) takes \{ pool\?: boolean \} \(got \{"runs":2\}\)\. Eval options such as compare go after the name/,
      ],
      [
        'a zero timeout',
        () => evaluate('e', { timeout: 0 }, async () => {}),
        /Invalid duration 0\. A duration is more than zero: use e\.g\. "90s" or "15m"\./,
      ],
      [
        'a timeout longer than a timer can be',
        () => evaluate('e', { timeout: '1000h' }, async () => {}),
        /Invalid duration "1000h"\. A duration is at most 596h \(2147483647ms\), the longest timer Node can set\./,
      ],
      [
        'a judge diff on a group',
        () =>
          group('g', { judge: { diff: ['src/'] } as never }, () => {
            evaluate('e', async () => {})
          }),
        /Unknown judge option "diff" in group\("g"\)\. diff is per call: c\.judge\(question, \{ diff \}\)\./,
      ],
      [
        'a file path that climbs out of the home directory',
        () => defineEnvironment('e', { files: { '~/../../x': 'x' } }),
        /files\["~\/\.\.\/\.\.\/x"\] in defineEnvironment\("e"\): paths .* never use \.\./,
      ],
      [
        'runs 0',
        () => evaluate('e', { runs: 0 }, async () => {}),
        /runs in evaluate\("e"\) must be a whole number of at least 1 \(got 0\)/,
      ],
      [
        'passRate instead of gate',
        () => evaluate('e', { passRate: 0.8 } as never, async () => {}),
        /Unknown option "passRate" in evaluate\("e"\)\. Did you mean "gate"\?/,
      ],
      [
        'no harness',
        () => evaluate('e', { harness: [] }, async () => {}),
        /harness is an empty list in evaluate\("e"\)/,
      ],
      [
        'an empty hosts list',
        () =>
          defineEnvironment('k', ({ secret }) => ({
            env: { K: secret.fromEnv('K', { hosts: [] }) },
          })),
        /secret\.fromEnv\("K"\): hosts must list the hosts the secret is sent to, e\.g\. hosts: \['api\.example\.com'\] or secret\.hosts\.gemini \(got \[\]\)/,
      ],
      [
        'a URL as a host',
        () =>
          defineEnvironment('k', ({ secret }) => ({
            env: { K: secret.fromEnv('K', { hosts: ['https://api.example.com/v1'] }) },
          })),
        /secret\.fromEnv\("K"\): hosts are host names, not URLs: use 'api\.example\.com' \(got 'https:\/\/api\.example\.com\/v1'\)/,
      ],
      [
        'a host that is not a string',
        () =>
          defineEnvironment('k', ({ secret }) => ({
            env: { K: secret.fromEnv('K', { hosts: [42 as never] }) },
          })),
        /secret\.fromEnv\("K"\): 42 isn't a host\. Use a name like 'api\.example\.com', or '\*\.example\.com' for its subdomains\./,
      ],
      [
        'in without hosts',
        () =>
          defineEnvironment('k', ({ secret }) => ({
            env: { K: secret.fromEnv('K', { in: ['query'] }) },
          })),
        /secret\.fromEnv\("K"\): in only applies to a brokered secret; add hosts, e\.g\. \{ hosts: \['api\.example\.com'\], in: \["query"\] \}/,
      ],
      [
        'a short-form IPv4 address in an egress allowlist',
        () => evaluate('e', { egress: { allow: ['10.1'] } }, async () => {}),
        /egress\.allow in evaluate\("e"\): '10\.1' isn't a host name or an IPv4 address/,
      ],
      [
        'the network policy under another name',
        () => evaluate('e', { network: 'deny-all' } as never, async () => {}),
        /Unknown option "network" in evaluate\("e"\)\. Did you mean "egress"\?/,
      ],
      [
        'deny-all on the fake sandbox',
        () => evaluate('e', { egress: 'deny-all' }, async () => {}),
        /evaluate\("e"\) runs under egress 'deny-all', which needs turning egress off, but the fake sandbox enforces no egress policy \(its commands run on the host\)\. Run it in docker\(\), or set egress: 'allow-all'\./,
      ],
      [
        "an environment's allowlist on the fake sandbox",
        () =>
          evaluate(
            'e',
            {
              environment: defineEnvironment('n', {
                sandbox: fakeSandbox(),
                egress: { allow: ['api.example.com'] },
              }),
            },
            async () => {},
          ),
        /evaluate\("e"\) runs under egress \{ allow: \['api\.example\.com'\] \}, which needs a host allowlist \(api\.example\.com\), but the fake sandbox enforces no egress policy/,
      ],
      [
        'two harnesses with one id',
        () => evaluate('e', { harness: [fakeHarness(), fakeHarness()] }, async () => {}),
        /Two harnesses in evaluate\("e"\) resolve to the id "fake"/,
      ],
      [
        'the singular plugin key',
        () =>
          defineEnvironment('review', (({ plugin }: EnvironmentHelpers) => ({
            plugin: [plugin.local('.')],
          })) as never),
        /Unknown field "plugin" in defineEnvironment\("review"\)\. Did you mean "plugins"\?/,
      ],
      [
        'a plugin only as a string',
        () =>
          defineEnvironment('review', ({ plugin }) => ({
            plugins: [plugin.local('.', { only: 'skills' as never })],
          })),
        /plugin\.local\("\."\): only lists the parts to place, from 'skills', 'agents', 'commands', 'hooks', 'mcp', 'rules'/,
      ],
      [
        'capture as a number',
        () => evaluate('e', { capture: 5173 as never }, async () => {}),
        /capture in evaluate\("e"\) is \{ viewport\?, timeout\?, browser\?, model\? \} \(got 5173\)/,
      ],
      [
        'an unknown capture key',
        () => evaluate('e', { capture: { ready: true } as never }, async () => {}),
        /Unknown capture key "ready" in evaluate\("e"\)\. Use viewport, timeout, browser, model\./,
      ],
      [
        'capture.port on evaluate',
        () => evaluate('e', { capture: { port: 5173 } as never }, async () => {}),
        /Unknown capture key "port" in evaluate\("e"\)\. Use viewport, timeout, browser, model\./,
      ],
      [
        'a capture viewport without height',
        () => evaluate('e', { capture: { viewport: { width: 1280 } as never } }, async () => {}),
        /capture\.viewport in evaluate\("e"\) is \{ width, height \} or 'full-page'/,
      ],
      [
        'capture.browser as a string',
        () => evaluate('e', { capture: { browser: 'off' as never } }, async () => {}),
        /capture\.browser in evaluate\("e"\) is true or false \(got "off"\)/,
      ],
      [
        'a capture viewport with height and fullPage',
        () =>
          evaluate(
            'e',
            { capture: { viewport: { height: 720, fullPage: true } as never } },
            async () => {},
          ),
        /capture\.viewport in evaluate\("e"\) is \{ width, height \} or 'full-page', not \{ height, fullPage \}/,
      ],
      [
        'instructions without a vision model',
        () =>
          evaluate('e', { capture: { instructions: ['Fill the form'] } as never }, async () => {}),
        /capture\.instructions in evaluate\("e"\) can't be set: instructions go on the call/,
      ],
      [
        'an evaluation-model capture.model',
        () => evaluate('e', { capture: { model: 'typesafe-ai/jev-1.14.0' } }, async () => {}),
        /capture\.model "typesafe-ai\/jev-1\.14\.0" in evaluate\("e"\) is an evaluation model/,
      ],
      [
        'leftover capture.use',
        () =>
          evaluate(
            'e',
            { capture: { use: { model: 'google/gemini-3.8-flash' } } as never },
            async () => {},
          ),
        /Unknown capture key "use" in evaluate\("e"\)\. Set capture\.model/,
      ],
      [
        'leftover capture.fake',
        () => evaluate('e', { capture: { fake: [] } as never }, async () => {}),
        /Unknown capture key "fake" in evaluate\("e"\)\. Set capture\.model/,
      ],
    ]
    for (const [what, declare, message] of cases) {
      test(`${what} is refused with a fix`, async () => {
        assert.match(String(await refusal(declare)), message)
      })
    }

    test('a variant named baseline in a compare without a baseline or environment is refused', async () => {
      const declare = () =>
        evaluate(
          'e',
          { compare: { variants: [defineEnvironment('baseline', {})] } },
          async () => {},
        )
      assert.match(
        String(await refusal(declare, fakeConfigInput(false))),
        /compare in evaluate\("e"\) lists a variant named baseline, the name of the empty control a compare without a baseline or environment runs\. Rename the variant, or set compare\.baseline\./,
      )
    })

    test('compare arms on one workspace that differ in something else plan', async () => {
      const declare = () => {
        const base = defineEnvironment('base', ({ git }) => ({ workspace: git('..') }))
        const skilled = base.extendEnvironment('skilled', ({ git }) => ({
          workspace: git('..'),
          files: { 'SKILL.md': 'x' },
        }))
        const ruled = defineEnvironment('ruled', ({ git }) => ({
          workspace: git('..'),
          rules: 'Be brief.',
        }))
        const bare = defineEnvironment('bare', ({ git }) => ({ workspace: git('..') }))
        evaluate('extends', { compare: { baseline: base, variants: [skilled] } }, async () => {})
        evaluate('apart', { compare: { baseline: ruled, variants: [bare] } }, async () => {})
      }
      assert.equal(await refusal(declare), null)
    })

    const configCases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'a literal secret',
        { env: { GOOGLE_API_KEY: 'AIza-not-really' } },
        /env\.GOOGLE_API_KEY in reeval\.config\.ts is a literal string\. Pass secrets with secret\.fromEnv\(\) so they're redacted and never recorded\./,
      ],
      [
        'widening in a profile limit',
        { profiles: { pr: { limit: { harness: [fakeHarness({ id: 'a' })] } } } },
        /profiles\.pr\.limit\.harness in reeval\.config\.ts can only list harness ids to allow \(got fakeHarness\(\{ … \}\)\)\. To add harnesses, use profiles\.pr\.defaults\.harness\./,
      ],
      [
        'a usd budget',
        { budget: { usd: 20 } },
        /budget\.usd in reeval\.config\.ts isn't supported yet: reeval records the tokens harnesses report, but prices none and enforces no token budget\. Cap the run with attempts or duration\./,
      ],
      [
        'an unbrokered policy reeval does not know',
        { secrets: { unbrokered: 'deny' } },
        /secrets\.unbrokered in reeval\.config\.ts is 'warn' or 'error' \(got "deny"\)/,
      ],
      [
        'maxConcurrent 0 on a config harness',
        { harness: fakeHarness({ maxConcurrent: 0 }) },
        /harness\.maxConcurrent in reeval\.config\.ts must be a whole number of at least 1 \(got 0\)/,
      ],
      [
        'a judge diff option in the config',
        { judge: { model: fakeJudge({ score: 0.9 }), diff: ['src/'] } },
        /Unknown judge option "diff" in reeval\.config\.ts\. diff is per call: c\.judge\(question, \{ diff \}\)\./,
      ],
      [
        'a judge contents option in the config',
        { judge: { model: fakeJudge({ score: 0.9 }), contents: ['README.md'] } },
        /Unknown judge option "contents" in reeval\.config\.ts\. contents is per call: c\.judge\(question, \{ contents \}\)\./,
      ],
      [
        'a judge.state in the config',
        { judge: { model: fakeJudge({ score: 0.9 }), state: { transcript: true } } },
        /Unknown judge option "state" in reeval\.config\.ts\./,
      ],
      [
        'keeping no debug runs',
        { debug: { keep: 0 } },
        /debug\.keep in reeval\.config\.ts must be a whole number of at least 1 \(got 0\)/,
      ],
      [
        'a trace buffer size as text',
        { debug: { traceBufferMb: '8MB' } },
        /debug\.traceBufferMb in reeval\.config\.ts must be a number of megabytes above 0 \(got "8MB"\)/,
      ],
      [
        'a debug folder option',
        { debug: { dir: '/tmp/debug' } },
        /Unknown option "dir" in debug in reeval\.config\.ts\. Use keep, traceBufferMb\./,
      ],
      [
        'control reuse',
        { profiles: { pr: { reuse: 'control' } } },
        /Unknown option "reuse" in profiles\.pr in reeval\.config\.ts\. Reusing control results from \.history isn’t built yet/,
      ],
      [
        'a sandbox that is not docker() or fakeSandbox() on defineConfig',
        { sandbox: { kind: 'vm' } },
        /sandbox in reeval\.config\.ts must come from docker\(\), podman\(\) or fakeSandbox\(\)/,
      ],
      [
        'a sandbox that is not docker() or fakeSandbox() on profile defaults',
        { profiles: { pr: { defaults: { sandbox: { kind: 'vm' } } } } },
        /sandbox in profiles\.pr\.defaults in reeval\.config\.ts must come from docker\(\), podman\(\) or fakeSandbox\(\)/,
      ],
    ]
    for (const [what, extra, message] of configCases) {
      test(`${what} in the config is refused with a fix`, () => {
        assert.throws(
          () =>
            resolveConfig({ ...fakeConfigInput(), ...extra } as never, root, 'reeval.config.ts'),
          message,
        )
      })
    }
  })

  const cliCases: Array<[string, Record<string, string>, RegExp]> = [
    [
      'a refusal while the eval file loads',
      {
        'reeval.config.ts': fakeConfig(),
        'evals/o.eval.ts': `import { defineEnvironment } from 'reeval'
defineEnvironment('py', { dockerfile: './Dockerfile' } as never)
`,
      },
      /^reeval: evals\/o\.eval\.ts: "dockerfile" isn't an environment field \(defineEnvironment\("py"\)\)\. Put the image on the sandbox: sandbox: docker\(\{ dockerfile: … \}\)/m,
    ],
    [
      'a refusal while the eval is planned',
      {
        'reeval.config.ts': fakeConfig(),
        'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const a = defineEnvironment('a', {})
const b = defineEnvironment('b', {})
evaluate('e', { compare: { baseline: b, variants: [a], harness: ['sonnet'] } }, async () => {})
`,
      },
      /^reeval: evals\/o\.eval\.ts: compare\.harness lists sonnet, which evaluate\("e"\) doesn't run \(it runs fake\)\./m,
    ],
    [
      'a plugin without a manifest',
      {
        'reeval.config.ts': fakeConfig(),
        'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
evaluate('e', { environment: defineEnvironment('review', ({ plugin }) => ({ plugins: [plugin.local('..')] })) }, async () => {})
`,
      },
      /evaluate\("e"\) on fake: plugin\.local\('\.'\) has no \.claude-plugin\/plugin\.json/,
    ],
  ]
  for (const [what, files, message] of cliCases) {
    test(`${what} exits 2 with a fix`, async () => {
      const p = await project('mistake', files)
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, message)
    })
  }

  test('no reeval.config.* here or above exits 2 with a fix', async () => {
    const p = await project('no-config', {})
    const missing =
      /^reeval: No reeval\.config\.ts \(or reeval\.config\.mts, reeval\.config\.cts, reeval\.config\.js, reeval\.config\.mjs, reeval\.config\.cjs, reeval\.yaml, reeval\.yml\) here or above\. Run reeval init\.\n$/
    for (const argv of [
      ['run'],
      ['run', '--dry-run'],
      ['image', 'build'],
      ['image', 'build', '--dry-run'],
    ]) {
      const r = await runCli(p.dir, argv)
      assert.equal(r.code, 2, `${argv.join(' ') || 'run'}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, missing, argv.join(' ') || 'run')
    }
  })

  test('a reeval.yaml mistake, or a reeval.yaml beside reeval.config.ts, exits 2', async () => {
    const p = await project('yaml-mistake', {
      'reeval.yaml': 'harness: { kind: fake }\nsandbox: { kind: fake }\nhistory: { dirr: runs }\n',
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    const typo = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(typo.code, 2, typo.stdout + typo.stderr)
    assert.match(
      typo.stderr,
      /^reeval: Unknown option "dirr" in history in reeval\.yaml\. Did you mean "dir"\?\n$/,
    )
    writeFileSync(join(p.dir, 'reeval.config.ts'), 'export default {}\n')
    const both = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(both.code, 2, both.stdout + both.stderr)
    assert.match(
      both.stderr,
      /^reeval: reeval\.config\.ts and reeval\.yaml are both in \.: reeval reads one config per directory\. Keep one, or pass --config\.\n$/,
    )
  })

  test('config errors name the config file that was read, as typed from the current directory', async () => {
    const bad = (extra: string) =>
      config(extra).replace(
        "import { defineConfig } from 'reeval'",
        "import { defineConfig, defineEnvironment } from 'reeval'",
      )
    const p = await project('config-path', {
      'reeval.config.ts': bad('harnesses: [],'),
      'reeval.compare.config.ts': bad(`compare: { variants: [defineEnvironment('x', {})] },`),
      'reeval.secret.config.ts': bad(`env: { GOOGLE_API_KEY: 'AIza-not-really' },`),
      'reeval.empty.config.ts': bad('harness: [],'),
      'reeval.none.config.ts': fakeConfig().replace(
        'export default defineConfig({',
        'defineConfig({',
      ),
      'reeval.profile.config.ts': bad(`profiles: { pr: {} },`),
      'reeval.budget.config.ts': bad('budget: { attempts: 1 },'),
      'reeval.include.config.ts': bad(`include: ['nothing/**/*.eval.ts'],`),
      'reeval.judge.config.ts': bad('').replace('judge: { model: fakeJudge({ score: 0.9 }) },', ''),
      'reeval.unbrokered.config.ts': bad(`secrets: { unbrokered: 'error' },`),
      'evals/o.eval.ts': `import { evaluate } from 'reeval'\nevaluate('e', { runs: 2 }, async () => {})\n`,
      'evals/j.eval.ts': `import { evaluate } from 'reeval'
evaluate('judged', async (c) => { await c.send('x'); await c.judge('ok?', { diff: true }) })
`,
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const env = defineEnvironment('s', ({ secret }) => ({
  sandbox: docker(),
  env: { AWS_SECRET_ACCESS_KEY: secret.fromEnv('AWS_SECRET_ACCESS_KEY') },
}))
evaluate('one', { environment: env }, async () => {})
`,
    })
    const cases: Array<[string, string[], RegExp]> = [
      ['.', [], /Unknown option "harnesses" in reeval\.config\.ts\. Did you mean "harness"\?/],
      [
        'evals',
        [],
        /Unknown option "harnesses" in \.\.\/reeval\.config\.ts\. Did you mean "harness"\?/,
      ],
      [
        '.',
        ['--config', 'reeval.compare.config.ts'],
        /compare can't be set in reeval\.compare\.config\.ts:/,
      ],
      [
        '.',
        ['--config', 'reeval.secret.config.ts'],
        /env\.GOOGLE_API_KEY in reeval\.secret\.config\.ts is a literal string/,
      ],
      [
        '.',
        ['--config', 'reeval.empty.config.ts'],
        /harness is an empty list in reeval\.empty\.config\.ts\./,
      ],
      [
        'evals',
        ['--config', '../reeval.none.config.ts'],
        /^reeval: \.\.\/reeval\.none\.config\.ts has no default export/m,
      ],
      [
        '.',
        ['--config', 'reeval.profile.config.ts', '--profile', 'nope'],
        /Profiles in reeval\.profile\.config\.ts: pr\./,
      ],
      [
        '.',
        ['--config', 'reeval.budget.config.ts', 'o.eval'],
        /over budget\.attempts 1 \(reeval\.budget\.config\.ts\)/,
      ],
      [
        '.',
        ['--config', 'reeval.include.config.ts'],
        /or set include in reeval\.include\.config\.ts\./,
      ],
      [
        '.',
        ['--config', 'reeval.unbrokered.config.ts', 's.eval'],
        /secrets\.unbrokered is 'error' in reeval\.unbrokered\.config\.ts\./,
      ],
    ]
    await Promise.all(
      cases.map(async ([cwd, args, message]) => {
        const r = await runCli(join(p.dir, cwd), ['run', ...args], {
          env: { AWS_SECRET_ACCESS_KEY: 'not-a-real-secret-value' },
        })
        assert.equal(r.code, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message)
        if (args.length)
          assert.doesNotMatch(r.stderr, /(?<![\w./])reeval\.config\.ts/, args.join(' '))
      }),
    )
    const judged = await runCli(p.dir, ['run', '--config', 'reeval.judge.config.ts', 'j.eval'])
    assert.equal(judged.code, 1, judged.stdout + judged.stderr)
    assert.match(
      readRun(p.dir).evals[0]?.error?.message ?? '',
      /Set judge: \{ model: 'typesafe-ai\/jev-1\.14\.0' \} in reeval\.judge\.config\.ts,/,
    )
  })

  for (const [what, replacement, message] of [
    [
      'no export',
      'defineConfig({',
      /reeval\.config\.ts has no default export\. Write export default defineConfig\(\{…\}\)\./,
    ],
    [
      'a named export',
      'export const config = defineConfig({',
      /reeval\.config\.ts has no default export \(it exports config\)\. Write export default defineConfig\(\{…\}\)\./,
    ],
  ] as const) {
    test(`a config with ${what} exits 2 instead of running the default harness`, async () => {
      const p = await project('config-no-default', {
        'reeval.config.ts': fakeConfig().replace('export default defineConfig({', replacement),
        'evals/o.eval.ts': `import { evaluate } from 'reeval'\nevaluate('e', async () => {})\n`,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, message)
    })
  }

  const unbrokeredEval = `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const keys = defineEnvironment('keys', ({ secret }) => ({
  sandbox: docker(),
  env: {
    GEMINI_API_KEY: secret.fromEnv('HOST_GEMINI', { hosts: secret.hosts.gemini }),
    AWS_SECRET_ACCESS_KEY: secret(),
  },
}))
evaluate('one', { environment: keys }, async () => {})
evaluate('two', { environment: keys }, async () => {})
`

  test("an optional secret that isn't set gets no real-value warning; set, it does", async () => {
    const p = await project('unbrokered-optional', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const maybe = defineEnvironment('maybe', ({ secret }) => ({
  sandbox: docker(),
  env: { SENTRY_TOKEN: secret.fromEnv('REEVAL_TEST_MAYBE_TOKEN', { optional: true }) },
}))
evaluate('one', { environment: maybe }, async () => {})
`,
    })
    const warning = /SENTRY_TOKEN is in the sandbox as its real value/
    const unset = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(unset.code, 0, unset.stdout + unset.stderr)
    assert.doesNotMatch(unset.stdout, warning)
    // The canary: set on the host, it does reach the sandbox as its real value.
    const set = await runCli(p.dir, ['run', '--dry-run'], {
      env: { REEVAL_TEST_MAYBE_TOKEN: 'set-for-the-canary' },
    })
    assert.match(set.stdout, warning)
  })

  test("secrets: { unbrokered: 'error' } refuses an optional secret whether or not it's set", async () => {
    const p = await project('unbrokered-optional-strict', {
      'reeval.config.ts': fakeConfig({ extra: "secrets: { unbrokered: 'error' }," }),
      'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const maybe = defineEnvironment('maybe', ({ secret }) => ({
  sandbox: docker(),
  env: { SENTRY_TOKEN: secret.fromEnv('REEVAL_TEST_MAYBE_TOKEN', { optional: true }) },
}))
evaluate('one', { environment: maybe }, async () => {})
`,
    })
    const refused =
      /SENTRY_TOKEN in evaluate\("one"\) isn't brokered, and secrets\.unbrokered is 'error'/
    for (const env of [{}, { REEVAL_TEST_MAYBE_TOKEN: 'set-on-this-host' }]) {
      const r = await runCli(p.dir, ['run', '--dry-run'], { env })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, refused)
    }
  })

  test('a Docker secret without hosts warns once in the plan', async () => {
    const p = await project('unbrokered', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': unbrokeredEval,
    })
    const r = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const warning =
      /^warning: AWS_SECRET_ACCESS_KEY is in the sandbox as its real value\. To give the agent only a placeholder, add the hosts it's sent to, e\.g\. secret\.fromEnv\('AWS_SECRET_ACCESS_KEY', \{ hosts: \['api\.example\.com'\] \}\)\.$/gm
    assert.equal(r.stdout.match(warning)?.length, 1, r.stdout)
    assert.doesNotMatch(r.stdout, /GEMINI_API_KEY is in the sandbox/)
  })

  test("secrets: { unbrokered: 'error' } refuses a Docker secret without hosts", async () => {
    const p = await project('unbrokered-strict', {
      'reeval.config.ts': fakeConfig({ extra: "secrets: { unbrokered: 'error' }," }),
      'evals/o.eval.ts': unbrokeredEval,
    })
    const r = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /AWS_SECRET_ACCESS_KEY in evaluate\("one"\) isn't brokered, and secrets\.unbrokered is 'error' in reeval\.config\.ts\. To broker it, add the hosts it's sent to, e\.g\. secret\.fromEnv\('AWS_SECRET_ACCESS_KEY', \{ hosts: \['api\.example\.com'\] \}\)\./,
    )
  })

  test("secrets: { unbrokered: 'error' } refuses a to: 'checks' secret without hosts before setup runs", async () => {
    const serverEval = (secret: string) => `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const server = defineEnvironment('server', ({ secret }) => ({
  sandbox: docker(),
  env: { CHECK_TOKEN: ${secret} },
  setup: ['nohup sleep 600 >/dev/null 2>&1 &'],
}))
evaluate('one', { environment: server }, async () => {})
`
    const config = fakeConfig({ extra: "secrets: { unbrokered: 'error' }," })
    const env = { CHECK_TOKEN: 'set-on-this-host' }
    const p = await project('unbrokered-checks-strict', {
      'reeval.config.ts': config,
      'evals/o.eval.ts': serverEval("secret({ to: 'checks' })"),
    })
    const r = await runCli(p.dir, ['run'], { env })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /CHECK_TOKEN in evaluate\("one"\) isn't brokered, and secrets\.unbrokered is 'error' in reeval\.config\.ts\./,
    )
    // Twin: brokered with hosts, the same eval plans.
    const brokered = await project('unbrokered-checks-brokered', {
      'reeval.config.ts': config,
      'evals/o.eval.ts': serverEval("secret({ to: 'checks', hosts: ['api.example.com'] })"),
    })
    const ok = await runCli(brokered.dir, ['run', '--dry-run'], { env })
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  })

  test('a moving git ref warns in the plan', async () => {
    const p = await project('moving-ref', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
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
      'reeval.config.ts': `
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig(({ secret }) => ({
  harness: fakeHarness({}),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  env: { APP_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN'), MODE: 'test' },
}))
`,
      'skills/house-greeting/SKILL.md': SKILL,
      'skills/house-greeting/examples.md': 'Ahoy, Ada!\n',
      'docs/api.md': '# API\n',
      'evals/envs.ts': `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const plain = defineEnvironment('plain', { sandbox })
export const withSkill = defineEnvironment('with-skill', ({ file, mcp, secret, skill }) => ({
  sandbox,
  skills: [skill.local('../skills')],
  mcp: { docs: mcp.stdio('npx', ['-y', 'docs-mcp', '--port', '0']) },
  rules: 'Always write tests.',
  files: { 'notes/readme.txt': 'hello', 'docs/api.md': file('../docs/api.md') },
  env: {
    FLAVOR: 'mint',
    EXTRA_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN'),
    CHECK_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN', { to: 'checks' }),
    MAYBE_TOKEN: secret.fromEnv('REEVAL_TEST_NOT_SET', { optional: true }),
  },
  setup: [{ run: 'printf %s "$EXTRA_TOKEN$CHECK_TOKEN" | wc -c > secret-length.txt', timeout: '10s' }],
}))
`,
      'evals/e.eval.ts': `import { evaluate, expect } from 'reeval'
import { plain, withSkill } from './envs.ts'
evaluate('greets', { runs: 1, compare: { baseline: plain, variants: [withSkill] } }, async (c) => {
  const turn = await c.send('greet')
  const loaded = turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting; mcp: docs')
  const token = (await c.exec('printf %s "$APP_TOKEN"')).stdout
  expect(token).toBe('s3cret-value-123')
  expect((await c.exec('printf %s "$MODE"')).stdout).toBe('test')
  if (c.attempt.cell.role === 'control') {
    expect(loaded).toBe(false)
    expect(await c.readFile('AGENTS.md')).toBeNull()
    throw new Error('the control never knows the house style')
  }
  expect(loaded).toBe(true)
  expect(await c.readFile('AGENTS.md')).toBe('Always write tests.')
  expect(await c.readFile('notes/readme.txt')).toBe('hello')
  expect(await c.readFile('docs/api.md')).toBe('# API\\n')
  expect((await c.readFile('secret-length.txt'))?.trim()).toBe('32')
  expect((await c.exec('printf %s "$FLAVOR"')).stdout).toBe('mint')
  expect((await c.exec('printf %s "$CHECK_TOKEN"')).stdout).toBe('s3cret-value-123')
  expect(turn.diff.files.map((f) => f.path)).not.toContain('AGENTS.md')
})
`,
    })
    const r = await runCli(p.dir, ['run', '--output-logs', 'full'], {
      env: { REEVAL_TEST_HOST_TOKEN: 's3cret-value-123' },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^\[greets#1 with-skill\] ▶ evals\/e\.eval\.ts › greets/m)
    assert.match(r.stdout, /^ {2}with-skill +1 of 1 {2}can't tell yet$/m)
    const { run, evals, dir } = readRun(p.dir)
    const envs = Object.fromEntries(run.environments.map((e) => [e.name, e]))
    assert.deepEqual(Object.keys(envs).sort(), ['plain', 'with-skill'])
    const w = envs['with-skill']
    assert.deepEqual(
      w?.skills.map((s) => [s.name, s.source, s.commit]),
      [['house-greeting', 'local:skills', null]],
    )
    assert.deepEqual(w?.mcp, ['docs'])
    assert.deepEqual(w?.secrets, ['APP_TOKEN', 'CHECK_TOKEN', 'EXTRA_TOKEN'])
    assert.deepEqual(w?.unset, ['MAYBE_TOKEN'])
    assert.deepEqual(w?.vars, ['FLAVOR', 'MODE'])
    assert.equal('image' in (w ?? {}), false, 'environments record no image steps')
    assert.equal(w?.setup.length, 1)
    const [e] = evals
    const variant = e?.attempts.find((a) => a.cell === 'fake/with-skill/fake')
    assert.deepEqual(variant?.env, {
      vars: ['FLAVOR', 'MODE'],
      secrets: ['APP_TOKEN', 'CHECK_TOKEN', 'EXTRA_TOKEN'],
      brokered: [],
    })
    assert.ok(variant?.files.setupLog, 'setup steps write setup.log')
    assert.match(readRun(p.dir).read(variant?.files.setupLog?.path ?? ''), /exit 0 after \d+m?s/)
    assert.notEqual(e?.cells[0]?.fingerprint, e?.cells[1]?.fingerprint)
    let leaks = ''
    try {
      leaks = execFileSync('grep', ['-r', '-l', 's3cret-value-123', dir], { encoding: 'utf8' })
    } catch {}
    assert.equal(leaks, '', 'the secret value is redacted everywhere')
  })

  test('a missing secret is an infra error; a failing setup step names itself', async () => {
    const p = await project('missing-secret', {
      'reeval.config.ts': fakeConfig(),
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const needs = defineEnvironment('needs', ({ secret }) => ({
  sandbox: fakeSandbox(),
  env: { NEEDED: secret.fromEnv('REEVAL_TEST_NOT_SET') },
}))
evaluate('needs it', { environment: needs }, async (c) => { await c.send('x') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /Secret NEEDED \(from REEVAL_TEST_NOT_SET\) for environment needs .* isn't set\. Set it in the environment or \.env\.local\./,
    )

    const failing = await project('setup-fails', {
      'reeval.config.ts': fakeConfig(),
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const broken = defineEnvironment('broken', {
  sandbox: fakeSandbox(),
  setup: [{ run: 'true' }, { run: 'echo nope >&2; exit 4' }],
})
evaluate('x', { environment: broken, timeout: '1s' }, async (c) => { await c.send('x') })
`,
    })
    const f = await runCli(failing.dir)
    assert.equal(f.code, 3, f.stdout + f.stderr)
    assert.match(
      f.stdout,
      /setup step 2\/2 "echo nope >&2; exit 4" in environment broken exited 4 after \d+m?s \(see setup\.log\):\n.*nope/,
    )
  })

  test('skills come from a git URL at a ref, with the commit recorded; workspace placement', async () => {
    const p = await project('git-skill', { 'reeval.config.ts': fakeConfig() })
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
      join(p.dir, 'evals/g.eval.ts'),
      `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('remote', ({ skill }) => ({
  sandbox: fakeSandbox(),
  skills: [
    skill.git('${pathToFileURL(repo).href}', { ref: 'v1', path: 'skills', only: ['house-greeting'] }),
    skill.inline({ name: 'house-rules', description: 'Rules.', content: 'Be nice.' }, { placement: 'workspace' }),
  ],
}))
evaluate('loads it', { environment: env }, async (c) => {
  const turn = await c.send('x')
  expect(turn.transcript.some((e) => e.type === 'text' && e.text === 'Loaded skills: house-greeting, house-rules')).toBe(true)
  expect(await c.readFile('.agents/skills/house-rules/SKILL.md')).toContain('Be nice.')
  expect(turn.diff.files).toEqual([])
})
`,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const skills = readRun(p.dir).run.environments[0]?.skills
    assert.equal(skills?.[0]?.commit, sha)
    assert.equal(skills?.[0]?.source, `${pathToFileURL(repo).href}#v1:skills`)
    assert.deepEqual(
      skills?.map((s) => [s.name, s.placement]),
      [
        ['house-greeting', 'harness'],
        ['house-rules', 'workspace'],
      ],
    )
  })

  test("a local skill's evals/ and *.eval.ts stay out of the sandbox; a block description parses", async () => {
    const p = await project('skill-hygiene', {
      'reeval.config.ts': fakeConfig(),
      'evals/h.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('reviewer', ({ skill }) => ({
  sandbox: fakeSandbox(),
  skills: [skill.local('../skills/skill-reviewer', { placement: 'workspace' })],
}))
evaluate('staged', { environment: env }, async (c) => {
  await c.send('x')
  const md = await c.readFile('.agents/skills/skill-reviewer/SKILL.md')
  expect(md).toContain(${JSON.stringify(`description: ${JSON.stringify(REVIEWER_DESCRIPTION)}`)})
  expect(md).toContain('# Skill reviewer')
  expect(await c.readFile('.agents/skills/skill-reviewer/docs/checklist.md')).toContain('# Checklist')
  const listed = (await c.exec('cd .agents/skills/skill-reviewer && find . -type f | LC_ALL=C sort')).stdout
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
    assert.deepEqual([s?.name, s?.excluded], ['skill-reviewer', ['evals/', 'review.eval.ts']])
  })
})

describe('sandbox images', () => {
  const sandboxCases: Array<[string, string, RegExp]> = [
    [
      'two bases',
      `docker({ image: 'x:1', dockerfile: './Dockerfile' })`,
      /docker\(\) takes one base image, but got image and dockerfile\. Use image \(has the harness\), from \(a toolchain image reeval bakes the harness onto\) or dockerfile\./,
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
      /docker\(\{ dockerfile: "\.\/nope\/Dockerfile" \}\): .+[/\\]evals[/\\]nope[/\\]Dockerfile doesn't exist\. Paths are relative to the file that calls docker\(\)\./,
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
      /docker\(\{ install \}\) command "x": Invalid duration "soon"\. Use e\.g\. "90s" or "15m"\./,
    ],
    [
      'steps instead of install',
      `docker({ steps: ['x'] } as never)`,
      /Unknown docker\(\) option "steps"\. Did you mean "install"\?/,
    ],
    [
      'user instead of root',
      `docker({ user: 'root' } as never)`,
      /Unknown docker\(\) option "user"\. Did you mean "root"\?/,
    ],
    [
      'root that is not a boolean',
      `docker({ root: 'yes' } as never)`,
      /docker\(\{ root \}\) is true or false \(got "yes"\)/,
    ],
    [
      'a capability that is not a name',
      `docker({ capabilities: 'NET_RAW' } as never)`,
      /docker\(\{ capabilities \}\) takes Linux capability names, e\.g\. capabilities: \['NET_RAW'\] \(got "NET_RAW"\)/,
    ],
    [
      'a memory size docker does not take',
      `docker({ memory: '4GB' })`,
      /docker\(\{ memory \}\) takes a size such as '4g' or '512m', or bytes \(got "4GB"\)/,
    ],
    [
      'memorySwap instead of swap',
      `docker({ memorySwap: '8g' } as never)`,
      /Unknown docker\(\) option "memorySwap"\. Did you mean "swap"\?/,
    ],
    [
      'memswap instead of swap',
      `docker({ memswap: '8g' } as never)`,
      /Unknown docker\(\) option "memswap"\. Did you mean "swap"\?/,
    ],
    [
      'a negative swap',
      `docker({ swap: -1 })`,
      /docker\(\{ swap \}\) takes a size such as '2g' or '512m', bytes, or 0 for none \(got -1\)/,
    ],
    [
      'zero CPUs',
      `docker({ cpus: 0 })`,
      /docker\(\{ cpus \}\) takes a number of CPUs above zero, e\.g\. 1\.5 \(got 0\)/,
    ],
    [
      'a fractional process limit',
      `docker({ pids: 10.5 })`,
      /docker\(\{ pids \}\) takes a whole number of processes above zero \(got 10\.5\)/,
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
        'reeval.config.ts': fakeConfig(),
        'evals/Dockerfile': 'FROM debian:bookworm-slim\n',
        'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const env = defineEnvironment('e', { sandbox: ${sandbox} })
evaluate('e', { environment: env }, async () => {})
`,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${sandbox}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    })
  }

  test('reeval image build --dry-run lists every image the planned sandboxes need', async () => {
    const p = await project('image-plan', {
      'reeval.config.ts': `
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
const tools = defineEnvironment('tools', {
  sandbox: docker({ install: ['apt-get update && apt-get install -y jq', { run: 'jq --version', timeout: '1m' }] }),
})
export default defineConfig({
  harness: fakeHarness({}),
  environment: tools,
  judge: { model: fakeJudge() },
})
`,
      'docker/tools/Dockerfile': `ARG REEVAL_BASE\nFROM \${REEVAL_BASE}\nRUN echo tools\n`,
      'evals/py.Dockerfile': 'FROM python:3.12-slim\n',
      'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'
evaluate('default', async () => {})
evaluate('default again', async () => {})
evaluate('tools', { environment: defineEnvironment('own-tools', { sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }) }) }, async () => {})
evaluate('py', { environment: defineEnvironment('py', { sandbox: docker({ dockerfile: new URL('./py.Dockerfile', import.meta.url) }) }) }, async () => {})
evaluate('from', { environment: defineEnvironment('from', { sandbox: docker({ from: 'python:3.12-slim', maxConcurrent: 2 }) }) }, async () => {})
evaluate('fake', { environment: defineEnvironment('host', { sandbox: fakeSandbox() }) }, async () => {})
`,
    })
    const r = await runCli(p.dir, ['image', 'build', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout
    assert.match(out, /^images {2}4 sandbox images \(nothing built: --dry-run\)$/m)
    // Each step's standing depends on what this machine has built, so only its shape is checked.
    const st = '[✓+~✗?] '
    assert.match(
      out,
      new RegExp(
        `^docker\\+[0-9a-f]+ · cursor \\+ install · 2 evals\\n {2}${st}base +reeval-sandbox:cursor-[\\d.]+ +\\((ready|to build|stale|unchecked): .+\\)\\n {2}${st}install 2 commands +reeval-install:<base id \\+ commands> +\\(`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:tools · cursor · 1 eval\\n {2}${st}dockerfile docker/tools/Dockerfile +reeval-dockerfile:tools-<context \\+ reeval image id> +\\(.+\\)\\n {2}${st}harness +reeval-dockerfile:tools-<context \\+ reeval image id> +\\(`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:py\\.Dockerfile · cursor · 1 eval\\n {2}${st}dockerfile evals/py\\.Dockerfile +reeval-dockerfile:py-dockerfile-[0-9a-f]{16} .*\\n {2}${st}harness +reeval-sandbox:cursor-[\\d.]+-reeval-dockerfile-py-dockerfile-`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:python:3\\.12-slim · cursor · 1 eval\\n {2}${st}from python:3\\.12-slim +reeval-sandbox:cursor-[\\d.]+-python-3-12-slim-[0-9a-f]{8}`,
        'm',
      ),
    )
    assert.doesNotMatch(out, /fake/)
    const runs = join(p.dir, '.reeval', 'runs')
    assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, 0, 'a dry run writes no run')
  })

  test('reeval image build --profile plans the images with the profile, as reeval run does', async () => {
    const p = await project('image-profile', {
      'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { claudeCode, fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({}),
  judge: { model: fakeJudge() },
  profiles: {
    claude: { defaults: { harness: claudeCode({ model: 'claude-sonnet-5' }) } },
    tools: { tags: ['tools'] },
  },
})
`,
      'docker/tools/Dockerfile': `ARG REEVAL_BASE\nFROM \${REEVAL_BASE}\nRUN echo tools\n`,
      'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('plain', async () => {})
evaluate('tools', { tags: ['tools'], environment: defineEnvironment('tools', { sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }) }) }, async () => {})
`,
    })
    const cursor = /^ {2}[✓+~✗?] base +reeval-sandbox:cursor-[\d.]+ /m
    const claude = /^ {2}[✓+~✗?] base +reeval-sandbox:claude-code-[\w.-]+ /m
    const tools = /^docker:tools · [\w-]+ · 1 eval$/m
    const dry = async (args: string[], env?: Record<string, string>) => {
      const r = await runCli(p.dir, ['image', 'build', '--dry-run', ...args], env ? { env } : {})
      assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
      return r.stdout
    }

    const none = await dry([])
    assert.match(none, cursor)
    assert.doesNotMatch(none, claude)
    assert.match(none, tools)
    // The profile's harness picks its image.
    const onClaude = await dry(['--profile', 'claude'])
    assert.match(onClaude, claude)
    assert.doesNotMatch(onClaude, cursor)
    // Its tags narrow the evals, so the plain eval's image drops out.
    const tagged = await dry(['--profile', 'tools'])
    assert.match(tagged, /^images {2}1 sandbox image /m)
    assert.match(tagged, tools)
    assert.doesNotMatch(tagged, /^docker · /m)
    // REEVAL_PROFILE works too, and the flag wins over it.
    assert.match(await dry([], { REEVAL_PROFILE: 'claude' }), claude)
    assert.match(await dry(['--profile', 'claude'], { REEVAL_PROFILE: 'tools' }), claude)

    const unknown = await runCli(p.dir, ['image', 'build', '--dry-run', '--profile', 'nope'])
    assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr)
    assert.match(
      unknown.stderr,
      /^reeval: Unknown profile "nope"\. Profiles in reeval\.config\.ts: claude, tools\.\n$/,
    )
    // A missing config is refused before a profile is named.
    const bare = await project('image-profile-bare', {})
    const noConfig = await runCli(bare.dir, ['image', 'build', '--dry-run', '--profile', 'x'])
    assert.equal(noConfig.code, 2, noConfig.stdout + noConfig.stderr)
    assert.match(
      noConfig.stderr,
      /^reeval: No reeval\.config\.ts \(or reeval\.config\.mts, reeval\.config\.cts, reeval\.config\.js, reeval\.config\.mjs, reeval\.config\.cjs, reeval\.yaml, reeval\.yml\) here or above\. Run reeval init\.\n$/,
    )
  })
})
