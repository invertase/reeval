import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fakeConfig, project, readRun, recordedRuns, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'

const config = (extra: string, harness = 'fakeHarness({})') => `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: ${harness},
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
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
      'reeval.config.ts': config(
        '',
        `[fakeHarness({ id: 'good', files: { 'ok.txt': 'yes' } }), fakeHarness({ id: 'bad' })]`,
      ),
      'evals/m.eval.ts': `import { evaluate, expect, group } from 'reeval'
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
    assert.match(r.stdout, /^\[writes#1 good\] ✓ evals\/m\.eval\.ts › g › writes ok\.txt/m)
    assert.match(r.stdout, /^\[writes#2 bad\] ✗ evals\/m\.eval\.ts › g › writes ok\.txt/m)
    assert.match(r.stdout, /✗ writes ok\.txt +2\/4 +50% +4 attempts\n +good\/-\/fake +2\/2 +100%/)
    assert.match(r.stdout, /bad\/-\/fake +0\/2 +0%/)
    assert.match(r.stdout, /2 passed · 2 failed \(4 attempts, 1 evals\)/)
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
        ['good/-/fake', 'control', 'all', 2, 2, 1, 'pass'],
        ['bad/-/fake', 'control', 'all', 2, 0, 0, 'fail'],
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
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'evals/c.eval.ts': `import { evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
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

  test('harness edits as data: { add } appends to the inherited list, { only } keeps by id', async () => {
    const p = await project('harness-edits', {
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'evals/e.eval.ts': `import { evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
group('only a', { harness: { only: 'a' } }, () => {
  evaluate('kept', async (t) => { await t.send('x') })
  evaluate('added', { harness: { add: [fakeHarness({ id: 'd' })] } }, async (t) => { await t.send('x') })
})
evaluate('kept both', { harness: { only: ['b', 'a'] } }, async (t) => { await t.send('x') })
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

  test('t.judge without a model names where to set one', async () => {
    const p = await project('no-judge', {
      'reeval.config.ts': config('').replace('judge: { model: fakeJudge({ score: 0.9 }) },', ''),
      'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
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
      /t\.judge\(\) has no model\. Set judge: \{ model: 'typesafe-ai\/jev-1\.13\.0' \} in reeval\.config\.ts/,
    )
    assert.equal(readRun(p.dir).evals[0]?.error?.kind, 'judge')
  })
})

describe('compare', () => {
  const envs = `import { defineEnvironment } from 'reeval'
export const base = defineEnvironment('base', { env: { MODE: 'base' } })
export const skilled = base.extendEnvironment('skilled', ({ skill }) => ({
  env: { MODE: 'skilled' },
  skills: [skill.local('../skills')],
}))
`

  test('variants run next to the control, lift is stored, and the control is not gated', async () => {
    const p = await project('compare', {
      'reeval.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate, expect, group } from 'reeval'
import { base, skilled } from './envs.ts'
group('g', { compare: { baseline: base, variants: [skilled] }, runs: 2 }, () => {
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
    assert.match(r.stdout, /^\[writes#1 control\] ○ .*\(not gated\)$/m)
    assert.match(r.stdout, /^\[writes#1 skilled\] ✓ /m)
    assert.match(r.stdout, /fake\/base\/fake +control +0\/2 +0% +not gated/)
    assert.match(r.stdout, /fake\/skilled\/fake +variant +2\/2 +100% +lift \+100 pts/)
    assert.match(r.stdout, /overrides: env\.MODE/)
    // A successful compare reads as one: the control's expected misses aren't failures.
    assert.doesNotMatch(r.stdout, /✗|Failures|Assertion failures|failed/)
    assert.match(r.stdout, /^Expected misses, not gated \(2\)$/m)
    assert.match(r.stdout, /^ ○ evals\/c\.eval\.ts › g › writes ok\.txt {2}fake\/base\/fake#1$/m)
    const section = r.stdout.slice(
      r.stdout.indexOf('Expected misses'),
      r.stdout.indexOf('Attempts'),
    )
    assert.equal(section.trim().split('\n').length, 1 + 2 * 3, 'a name, a reason and a record each')
    assert.match(r.stdout, /2 passed · 2 missed, not gated \(4 attempts, 1 evals\)/)

    const colour = await runCli(p.dir, ['run'], { env: { FORCE_COLOR: '1' } })
    assert.equal(colour.code, 0, colour.stdout + colour.stderr)
    assert.ok(!colour.stdout.includes('\x1b[31m'), 'nothing red')

    const agent = await runCli(p.dir, ['run', '--ui', 'agent'])
    assert.equal(agent.code, 0, agent.stdout + agent.stderr)
    assert.doesNotMatch(agent.stdout, /^FAIL /m)
    assert.match(
      agent.stdout,
      /^MISS evals\/c\.eval\.ts › g › writes ok\.txt \[.*\] \(.*, assertion, not gated\)$/m,
    )
    assert.match(agent.stdout, /^2 passed, 2 missed, not gated \(4 attempts, 1 evals\)$/m)

    const gha = await runCli(p.dir, ['run', '--log-order', 'grouped'], {
      env: { GITHUB_ACTIONS: 'true' },
    })
    assert.equal(gha.code, 0, gha.stdout + gha.stderr)
    assert.doesNotMatch(gha.stdout, /^::error/m)
    assert.equal(gha.stdout.match(/^::group::/gm)?.length, 4, 'expected misses collapse too')

    const md = readRun(p.dir).read('summary.md')
    assert.match(md, /^2 passed · 2 missed, not gated \(4 attempts, 1 evals\)/m)
    assert.doesNotMatch(md, /✗|failed/)
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
    assert.match(readRun(p.dir).read('summary.md'), /fake\/skilled\/fake 2\/2 \(lift \+100 pts/)
  })

  test("gate 'all' gates the control, and minLift fails a variant cell below it", async () => {
    const p = await project('compare-gates', {
      'reeval.config.ts': config('', SKILLED),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('all gated', { compare: { baseline: base, variants: [skilled], gate: 'all' } }, async (t) => {
  await t.send('go')
  await expect(t).toHaveFile('ok.txt')
})
evaluate('no worse', { compare: { baseline: base, variants: [skilled], minLift: 0.5, gate: 'none' } }, async (t) => {
  await t.send('go')
  if (t.attempt.cell.role === 'variant') throw new Error('the variant is worse')
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
    assert.match(r.stdout, /^Failures \(1\)$/m)
    assert.match(r.stdout, /^ ✗ evals\/c\.eval\.ts › all gated {2}fake\/base\/fake#1$/m)
    assert.match(r.stdout, /^Expected misses, not gated \(1\)$/m)
    assert.match(r.stdout, /^ ○ evals\/c\.eval\.ts › no worse {2}fake\/skilled\/fake#1$/m)
    assert.match(
      r.stdout,
      /lift −100 pts \(95% −100…\+12, 0\/1 vs 1\/1\), within noise \(minLift 50\) ✗/,
    )
  })

  test('compare.harness scopes variants; other harnesses run the control only', async () => {
    const p = await project('compare-scope', {
      'reeval.config.ts': config('', `[fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })]`),
      'skills/house-greeting/SKILL.md': SKILL,
      'evals/envs.ts': envs,
      'evals/c.eval.ts': `import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('scoped', { compare: { baseline: base, variants: [skilled], harness: ['b'] } }, async (t) => { await t.send('x') })
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
    `evaluate('${name}', { runs: 5${options} }, async (t) => {
  if (t.attempt.n === 3) throw new Error('the third attempt fails')
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
      /^hint: 1 eval runs more than once with the default gate, so every attempt must pass; set gate: \{ passRate: 0\.8 \} to gate on a pass rate instead$/m,
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
    assert.match(r.stdout, /gate passRate 0\.8/, 'the summary names a non-default gate')

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
      /^plan {2}profile pr \(auto: CI is set\) · 3 evals \(1 skipped\) · 4 cells · 6 attempts · ~.* · budget 5 attempts ✗$/m,
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

  test('a profile name typo exits 2 and lists the profiles', async () => {
    const p = await fixture('plan/profiles')
    const typo = await runCli(p.dir, ['run', '--profile', 'nigthly'])
    assert.equal(typo.code, 2)
    assert.match(
      typo.stderr,
      /reeval: Unknown profile "nigthly"\. Profiles in reeval\.config\.ts: pr, nightly\./,
    )
  })

  test('budget.duration stops new attempts; the run is marked budget and exits 1', async () => {
    const p = await project('budget-duration', {
      'reeval.config.ts': config(
        `concurrency: 1, budget: { duration: '1s' },`,
        'fakeHarness({ delayMs: 700 })',
      ),
      'evals/b.eval.ts': `import { evaluate } from 'reeval'
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
evaluate('slow', { runs: 4 }, async (t) => { await t.send('x') })
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

describe('common mistakes', () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      'a list of environments',
      `group('genkit', { environment: [a, b] }, () => {})`,
      /environment takes one environment, not a list \(group\("genkit"\)\)\. To compare environments, use compare: \{ baseline, variants: \[a, b\] \}\. baseline is the control; variants are not layered on it\./,
    ],
    [
      'a variant with its own checks',
      `evaluate('e', { compare: { baseline: a, variants: [{ environment: a, check: () => {} }] } }, async () => {})`,
      /compare takes environments \(got an object with "environment", "check"\) in evaluate\("e"\)\. Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval\./,
    ],
    [
      'compare scoped to a harness the eval does not run',
      `evaluate('e', { compare: { baseline: b, variants: [a], harness: ['sonnet'] } }, async () => {})`,
      /compare\.harness lists sonnet, which evaluate\("e"\) doesn't run \(it runs fake\)\./,
    ],
    [
      'compare without a baseline',
      `evaluate('e', { compare: { variants: [a] } }, async () => {})`,
      /compare\.baseline in evaluate\("e"\) must be an environment from defineEnvironment \(got undefined\)/,
    ],
    [
      'compare as an array',
      `evaluate('e', { compare: [a] }, async () => {})`,
      /compare must be an object in evaluate\("e"\)\. Use compare: \{ baseline, variants: \[\.\.\.\] \}\./,
    ],
    [
      'a compare strategy',
      `evaluate('e', { compare: { baseline: a, variants: [b], strategy: 'peer' } }, async () => {})`,
      /Unknown compare option "strategy" in evaluate\("e"\)/,
    ],
    [
      'environment and compare on the same eval',
      `evaluate('e', { environment: a, compare: { baseline: a, variants: [b] } }, async () => {})`,
      /environment and compare can't both be set in evaluate\("e"\)\. compare: \{ baseline, variants \} names every arm, so drop environment\./,
    ],
    [
      'compare: false on an eval',
      `evaluate('e', { compare: false }, async () => {})`,
      /compare: false can't be set in evaluate\("e"\)\. A profile turns compare off with limit\.compare: false/,
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
      'a harness edit naming a harness the eval does not inherit',
      `evaluate('e', { harness: { only: 'cursor' } }, async () => {})`,
      /harness \{ only: "cursor" \} in evaluate\("e"\) names no inherited harness \(inherited: fake\)/,
    ],
    [
      'a harness edit that adds and keeps at once',
      `evaluate('e', { harness: { add: [], only: 'fake' } as never }, async () => {})`,
      /harness takes \{ add \} or \{ only \}, not both, in evaluate\("e"\)/,
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
      'an eval with no function',
      `evaluate('x', {})`,
      /evaluate\("x"\) has no function\. Pass the eval's body, e\.g\. evaluate\("x", async \(t\) => \{ … \}\)\./,
    ],
    [
      'a base image on an environment',
      `defineEnvironment('node', { image: 'node:22' })`,
      /"image" isn't an environment field \(defineEnvironment\("node"\)\)\. What's baked into the image is the sandbox's: docker\(\{ from: … \}\)/,
    ],
    [
      'a setup step with an empty cwd',
      `defineEnvironment('e', { setup: [{ run: 'ls', cwd: '' }] })`,
      /setup step "ls" in defineEnvironment\("e"\): cwd must be a directory path, relative to the workspace or absolute \(got ""\)/,
    ],
    [
      'a setup step with an unknown key',
      `defineEnvironment('e', { setup: [{ run: 'ls', dir: 'x' } as never] })`,
      /Steps in defineEnvironment\("e"\) are strings or \{ run, timeout\?, cwd\? \} objects \(got "dir"\)/,
    ],
    [
      'two evals with the same name',
      `evaluate('e', async () => {}); evaluate('e', { runs: 2 }, async () => {})`,
      /evaluate\("e"\) is declared twice in this file\. Each eval needs its own name, or its attempts are merged into one eval\./,
    ],
    [
      'evaluate.for cases with the same name',
      `evaluate.for([{ a: 1, b: 2 }, { a: 1, b: 3 }])('adds $a', async () => {})`,
      /evaluate\("adds 1"\) is declared twice in this file\. .* For evaluate\.for, put \$key, %s or %# in the name \("adds \$a"\) so each case's name differs\./,
    ],
    [
      'a zero timeout',
      `evaluate('e', { timeout: 0 }, async () => {})`,
      /Invalid duration 0\. A duration is more than zero: use e\.g\. "90s" or "15m"\./,
    ],
    [
      'a zero setup step timeout',
      `defineEnvironment('e', { setup: [{ run: 'ls', timeout: '0s' }] })`,
      /Invalid duration "0s"\. A duration is more than zero/,
    ],
    [
      'a judge threshold over 1 on a group',
      `group('g', { judge: { threshold: 2 } }, () => { evaluate('e', async () => {}) })`,
      /judge\.threshold must be between 0 and 1 \(got 2\) in group\("g"\)/,
    ],
    [
      'a file path that climbs out of the workspace',
      `defineEnvironment('e', { files: { '../../escape.txt': 'x' } })`,
      /files\["\.\.\/\.\.\/escape\.txt"\] in defineEnvironment\("e"\): paths are relative to the workspace, or start with ~\/ for the home directory, and never use \.\./,
    ],
    [
      'a file path that climbs out of the home directory',
      `defineEnvironment('e', { files: { '~/../../x': 'x' } })`,
      /files\["~\/\.\.\/\.\.\/x"\] in defineEnvironment\("e"\): paths .* never use \.\./,
    ],
    [
      'an absolute file path',
      `defineEnvironment('e', { files: { '/etc/hosts': 'x' } })`,
      /files\["\/etc\/hosts"\] in defineEnvironment\("e"\): paths are relative to the workspace/,
    ],
    [
      'a Windows-style file path',
      `defineEnvironment('e', { files: { 'docs\\\\api.md': 'x' } })`,
      /files\["docs\\\\api\.md"\] in defineEnvironment\("e"\): use forward slashes \(docs\/api\.md\)/,
    ],
    [
      'a zero install step timeout',
      `docker({ install: [{ run: 'ls', timeout: 0 }] })`,
      /docker\(\{ install \}\) command "ls": Invalid duration 0\. A duration is more than zero/,
    ],
    [
      'a negative install step timeout',
      `docker({ install: [{ run: 'ls', timeout: '-5s' }] })`,
      /docker\(\{ install \}\) command "ls": Invalid duration "-5s"\. Use e\.g\. "90s" or "15m"\./,
    ],
    [
      'runs 0',
      `evaluate('e', { runs: 0 }, async () => {})`,
      /runs must be a whole number of at least 1 \(got 0\)/,
    ],
    [
      'a gate as a percentage',
      `evaluate('e', { gate: { passRate: 80 } }, async () => {})`,
      /gate is 'all' \(every attempt passes\) or \{ passRate \} with a share above 0 and at most 1, e\.g\. gate: \{ passRate: 0\.8 \} \(got \{"passRate":80\}\) in evaluate\("e"\)/,
    ],
    [
      'passRate instead of gate',
      `evaluate('e', { passRate: 0.8 } as never, async () => {})`,
      /Unknown option "passRate" in evaluate\("e"\)\. Did you mean "gate"\?/,
    ],
    [
      'no harness',
      `evaluate('e', { harness: [] }, async () => {})`,
      /harness is an empty list in evaluate\("e"\)/,
    ],
    [
      'a harness kind reeval does not know',
      `evaluate('e', { harness: { kind: 'cline' } as never }, async () => {})`,
      /harness in evaluate\("e"\) must be like cursor\(\{ model: 'composer-2\.5' \}\) \(got an object with "kind"\)/,
    ],
    [
      'Claude Code without a model',
      `evaluate('e', { harness: (await import('reeval/harness')).claudeCode({} as never) }, async () => {})`,
      /claudeCode\(\) needs a model, e\.g\. claudeCode\(\{ model: 'claude-sonnet-5' \}\)/,
    ],
    [
      'Antigravity without a model',
      `evaluate('e', { harness: (await import('reeval/harness')).antigravity({} as never) }, async () => {})`,
      /antigravity\(\) needs a model, e\.g\. antigravity\(\{ model: 'gemini-3\.8-flash-medium' \}\)/,
    ],
    [
      'a fake agent layout reeval does not know',
      `evaluate('e', { harness: fakeHarness({ layout: 'cline' as never }) }, async () => {})`,
      /fakeHarness\(\{ layout \}\) is one of 'cursor', 'claude-code', 'antigravity', 'opencode', 'goose', 'pi', 'codex' \(got "cline"\)/,
    ],
    [
      'a fake agent script that is not one list per turn',
      `evaluate('e', { harness: fakeHarness({ script: [{ exec: 'ls' }] as never }) }, async () => {})`,
      /fakeHarness\(\{ script \}\) takes one list of steps per turn, e\.g\. script: \[\[\{ exec: 'cat notes\.txt' \}, \{ reply: 'done' \}\]\]/,
    ],
    [
      'a fake agent script step with two actions',
      `evaluate('e', { harness: fakeHarness({ script: [[{ exec: 'ls', reply: 'x' } as never]] }) }, async () => {})`,
      /fakeHarness\(\{ script \}\) steps are \{ exec: string \}, \{ write: \{ path: content \} \}, \{ reply: string \}, \{ mcp: '<server>\/<tool>' \} or \{ error: string \}/,
    ],
    [
      'a fake agent MCP step without a tool',
      `evaluate('e', { harness: fakeHarness({ script: [[{ mcp: 'stamp' }]] }) }, async () => {})`,
      /fakeHarness\(\{ script \}\) steps are .+ \{ mcp: '<server>\/<tool>' \} or \{ error: string \} \(got \{"mcp":"stamp"\}\)/,
    ],
    [
      'an empty hosts list',
      `defineEnvironment('k', ({ secret }) => ({ env: { K: secret.fromEnv('K', { hosts: [] }) } }))`,
      /secret\.fromEnv\("K"\): hosts must list the hosts the secret is sent to, e\.g\. hosts: \['api\.example\.com'\] or secret\.hosts\.gemini \(got \[\]\)/,
    ],
    [
      'a URL as a host',
      `defineEnvironment('k', ({ secret }) => ({ env: { K: secret.fromEnv('K', { hosts: ['https://api.example.com/v1'] }) } }))`,
      /secret\.fromEnv\("K"\): hosts are host names, not URLs: use 'api\.example\.com' \(got 'https:\/\/api\.example\.com\/v1'\)/,
    ],
    [
      'a host that is not a string',
      `defineEnvironment('k', ({ secret }) => ({ env: { K: secret.fromEnv('K', { hosts: [42 as never] }) } }))`,
      /secret\.fromEnv\("K"\): 42 isn't a host\. Use a name like 'api\.example\.com', or '\*\.example\.com' for its subdomains\./,
    ],
    [
      'substituting somewhere the gateway does not',
      `defineEnvironment('k', ({ secret }) => ({ env: { K: secret({ hosts: ['api.example.com'], in: ['cookie' as never] }) } }))`,
      /secret\(\): in lists where the gateway substitutes: 'header', 'query' and\/or 'body' \(got \["cookie"\]\)/,
    ],
    [
      'in without hosts',
      `defineEnvironment('k', ({ secret }) => ({ env: { K: secret.fromEnv('K', { in: ['query'] }) } }))`,
      /secret\.fromEnv\("K"\): in only applies to a brokered secret; add hosts, e\.g\. \{ hosts: \['api\.example\.com'\], in: \["query"\] \}/,
    ],
    [
      'egress as a list of hosts',
      `evaluate('e', { egress: ['api.example.com'] as never }, async () => {})`,
      /egress is 'allow-all' \(the default\), 'deny-all', or \{ allow: \['api\.example\.com', '\*\.example\.org'\] \} \(got \["api\.example\.com"\]\) in evaluate\("e"\)\. For a list of hosts, use \{ allow: \["api\.example\.com"\] \}\./,
    ],
    [
      'an egress deny list',
      `group('g', { egress: { deny: ['evil.example'] } as never }, () => {})`,
      /Unknown egress key "deny" in group\("g"\)\. A policy lists what's allowed; everything else is refused\./,
    ],
    [
      'a URL in an egress allowlist',
      `defineEnvironment('n', { egress: { allow: ['https://api.example.com/v1'] } })`,
      /egress\.allow in defineEnvironment\("n"\): hosts are host names, not URLs: use 'api\.example\.com' \(got 'https:\/\/api\.example\.com\/v1'\)/,
    ],
    [
      'a port in an egress allowlist',
      `evaluate('e', { egress: { allow: ['api.example.com:443'] } }, async () => {})`,
      /egress\.allow in evaluate\("e"\): hosts are host names without a port: use 'api\.example\.com' \(got 'api\.example\.com:443'\)/,
    ],
    [
      'a wildcard over a whole top-level domain',
      `evaluate('e', { egress: { allow: ['*.com'] } }, async () => {})`,
      /egress\.allow in evaluate\("e"\): '\*\.com' would allow every host under \.com; name the domain, e\.g\. '\*\.example\.com'\./,
    ],
    [
      'a wildcard over IP addresses',
      `evaluate('e', { egress: { allow: ['*.0.0.1'] } }, async () => {})`,
      /egress\.allow in evaluate\("e"\): '\*\.0\.0\.1' isn't a host name or an IPv4 address, and a \*\. pattern never matches an address\./,
    ],
    [
      'a short-form IPv4 address in an egress allowlist',
      `evaluate('e', { egress: { allow: ['10.1'] } }, async () => {})`,
      /egress\.allow in evaluate\("e"\): '10\.1' isn't a host name or an IPv4 address/,
    ],
    [
      'the network policy under another name',
      `evaluate('e', { network: 'deny-all' } as never, async () => {})`,
      /Unknown option "network" in evaluate\("e"\)\. Did you mean "egress"\?/,
    ],
    [
      'deny-all on the fake sandbox',
      `evaluate('e', { egress: 'deny-all' }, async () => {})`,
      /evaluate\("e"\) runs under egress 'deny-all', which needs turning egress off, but the fake sandbox enforces no egress policy \(its commands run on the host\)\. Run it in docker\(\), or set egress: 'allow-all'\./,
    ],
    [
      "an environment's allowlist on the fake sandbox",
      `evaluate('e', { environment: defineEnvironment('n', { egress: { allow: ['api.example.com'] } }) }, async () => {})`,
      /evaluate\("e"\) runs under egress \{ allow: \['api\.example\.com'\] \}, which needs a host allowlist \(api\.example\.com\), but the fake sandbox enforces no egress policy/,
    ],
    [
      'two harnesses with one id',
      `evaluate('e', { harness: [fakeHarness(), fakeHarness()] }, async () => {})`,
      /Two harnesses in evaluate\("e"\) resolve to the id "fake"/,
    ],
    [
      'a repository URL as the workspace',
      `defineEnvironment('app', { workspace: 'https://github.com/acme/app' as never })`,
      /workspace in defineEnvironment\("app"\) must come from the git helper, e\.g\. workspace: git\('https:\/\/github\.com\/acme\/app', \{ ref: 'v1\.0\.0' \}\)/,
    ],
    [
      "the token itself as git()'s token",
      `defineEnvironment('app', ({ git }) => ({ workspace: git('github:acme/app', { token: 'ghp_abc123def456' }) }))`,
      /git\("github:acme\/app"\): token names the host variable that holds the token, e\.g\. token: 'GITHUB_TOKEN'\. Don't put the token itself in the eval\./,
    ],
    [
      'a token in the workspace URL',
      `defineEnvironment('app', ({ git }) => ({ workspace: git('https://x-access-token:ghp_abc123@github.com/acme/app') }))`,
      /git\("https:\/\/\*\*\*:\*\*\*@github\.com\/acme\/app"\): the URL has a password or token in it\. reeval fetches the repository on the host with your own git credentials/,
    ],
  ]
  for (const [what, body, message] of cases) {
    test(`${what} exits 2 with a fix`, async () => {
      const p = await project('mistake', {
        'reeval.config.ts': fakeConfig(),
        'evals/o.eval.ts': `import { defineEnvironment, evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'
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
      `compare: { variants: [defineEnvironment('x', {})] },`,
      /compare can't be set in reeval\.config\.ts: it would multiply every eval\. Put it on the group or eval that asks the question\./,
    ],
    [
      'a literal secret',
      `env: { GOOGLE_API_KEY: 'AIza-not-really' },`,
      /env\.GOOGLE_API_KEY in reeval\.config\.ts is a literal string\. Pass secrets with secret\.fromEnv\(\) so they're redacted and never recorded\./,
    ],
    [
      'widening in a profile limit',
      `profiles: { pr: { limit: { harness: [fakeHarness({ id: 'a' })] } } },`,
      /profiles\.pr\.limit\.harness can only list harness ids to allow \(got fakeHarness\(\{ … \}\)\)\. To add harnesses, use profiles\.pr\.defaults\.harness\./,
    ],
    [
      'a usd budget',
      `budget: { usd: 20 },`,
      /budget\.usd isn't supported yet: reeval records the tokens harnesses report, but prices none and enforces no token budget\. Cap the run with attempts or duration\./,
    ],
    [
      'an unbrokered policy reeval does not know',
      `secrets: { unbrokered: 'deny' as never },`,
      /config\.secrets\.unbrokered is 'warn' or 'error' \(got "deny"\)/,
    ],
    [
      'maxConcurrent 0 on a config harness',
      `harness: fakeHarness({ maxConcurrent: 0 }),`,
      /maxConcurrent must be a whole number of at least 1 \(got 0\) for harness in reeval\.config\.ts/,
    ],
    [
      'a judge threshold as text in the config',
      `judge: { model: fakeJudge({ score: 0.9 }), threshold: '0.8' as never },`,
      /judge\.threshold must be between 0 and 1 \(got 0\.8\) in reeval\.config\.ts/,
    ],
    [
      'keeping no debug runs',
      `debug: { keep: 0 },`,
      /config\.debug\.keep must be a whole number of at least 1 \(got 0\)/,
    ],
    [
      'a trace buffer size as text',
      `debug: { traceBufferMb: '8MB' as never },`,
      /config\.debug\.traceBufferMb must be a number of megabytes above 0 \(got 8MB\)/,
    ],
    [
      'a debug folder option',
      `debug: { dir: '/tmp/debug' } as never,`,
      /Unknown option "dir" in config\.debug\. Use keep, traceBufferMb\./,
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
        'reeval.config.ts': config(extra).replace(
          "import { defineConfig } from 'reeval'",
          "import { defineConfig, defineEnvironment } from 'reeval'",
        ),
        'evals/o.eval.ts': `import { evaluate } from 'reeval'\nevaluate('e', async () => {})\n`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, `${extra}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
    })
  }

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
evaluate('judged', async (t) => { await t.send('x'); await t.judge('ok?') })
`,
      'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const env = defineEnvironment('s', ({ secret }) => ({
  env: { AWS_SECRET_ACCESS_KEY: secret.fromEnv('AWS_SECRET_ACCESS_KEY') },
}))
evaluate('one', { sandbox: docker(), environment: env }, async () => {})
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
    for (const [cwd, args, message] of cases) {
      const r = await runCli(join(p.dir, cwd), ['run', ...args], {
        env: { AWS_SECRET_ACCESS_KEY: 'not-a-real-secret-value' },
      })
      assert.equal(r.code, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
      assert.match(r.stderr, message)
      if (args.length)
        assert.doesNotMatch(r.stderr, /(?<![\w./])reeval\.config\.ts/, args.join(' '))
    }
    const judged = await runCli(p.dir, ['run', '--config', 'reeval.judge.config.ts', 'j.eval'])
    assert.equal(judged.code, 1, judged.stdout + judged.stderr)
    assert.match(
      readRun(p.dir).evals[0]?.error?.message ?? '',
      /Set judge: \{ model: 'typesafe-ai\/jev-1\.13\.0' \} in reeval\.judge\.config\.ts,/,
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
  env: {
    GEMINI_API_KEY: secret.fromEnv('HOST_GEMINI', { hosts: secret.hosts.gemini }),
    AWS_SECRET_ACCESS_KEY: secret(),
  },
}))
evaluate('one', { sandbox: docker(), environment: keys }, async () => {})
evaluate('two', { sandbox: docker(), environment: keys }, async () => {})
`

  test("an optional secret that isn't set gets no real-value warning; set, it does", async () => {
    const p = await project('unbrokered-optional', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const maybe = defineEnvironment('maybe', ({ secret }) => ({
  env: { SENTRY_TOKEN: secret.fromEnv('REEVAL_TEST_MAYBE_TOKEN', { optional: true }) },
}))
evaluate('one', { sandbox: docker(), environment: maybe }, async () => {})
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
  env: { SENTRY_TOKEN: secret.fromEnv('REEVAL_TEST_MAYBE_TOKEN', { optional: true }) },
}))
evaluate('one', { sandbox: docker(), environment: maybe }, async () => {})
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
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig(({ secret }) => ({
  harness: fakeHarness({}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  env: { APP_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN'), MODE: 'test' },
}))
`,
      'skills/house-greeting/SKILL.md': SKILL,
      'skills/house-greeting/examples.md': 'Ahoy, Ada!\n',
      'docs/api.md': '# API\n',
      'evals/envs.ts': `import { defineEnvironment } from 'reeval'
export const withSkill = defineEnvironment('with-skill', ({ file, mcp, secret, skill }) => ({
  skills: [skill.local('../skills')],
  mcp: { docs: mcp.stdio('npx', ['-y', 'docs-mcp', '--port', '0']) },
  rules: 'Always write tests.',
  files: { 'notes/readme.txt': 'hello', 'docs/api.md': file('../docs/api.md') },
  env: {
    FLAVOUR: 'mint',
    EXTRA_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN'),
    CHECK_TOKEN: secret.fromEnv('REEVAL_TEST_HOST_TOKEN', { to: 'checks' }),
    MAYBE_TOKEN: secret.fromEnv('REEVAL_TEST_NOT_SET', { optional: true }),
  },
  setup: [{ run: 'printf %s "$EXTRA_TOKEN$CHECK_TOKEN" | wc -c > secret-length.txt', timeout: '10s' }],
}))
`,
      'evals/e.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { withSkill } from './envs.ts'
evaluate('greets', { compare: { baseline: defineEnvironment('plain', {}), variants: [withSkill] } }, async (t) => {
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
    const r = await runCli(p.dir, ['run'], { env: { REEVAL_TEST_HOST_TOKEN: 's3cret-value-123' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^\[greets#1 with-skill\] ✓ evals\/e\.eval\.ts › greets/m)
    assert.match(r.stdout, /with-skill\/fake +variant +1\/1 +100% +lift \+100 pts/)
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
    assert.deepEqual(w?.vars, ['FLAVOUR', 'MODE'])
    assert.equal('image' in (w ?? {}), false, 'environments record no image steps')
    assert.equal(w?.setup.length, 1)
    const [e] = evals
    const variant = e?.attempts.find((a) => a.cell === 'fake/with-skill/fake')
    assert.deepEqual(variant?.env, {
      vars: ['FLAVOUR', 'MODE'],
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
const needs = defineEnvironment('needs', ({ secret }) => ({ env: { NEEDED: secret.fromEnv('REEVAL_TEST_NOT_SET') } }))
evaluate('needs it', { environment: needs }, async (t) => { await t.send('x') })
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
const broken = defineEnvironment('broken', { setup: [{ run: 'true' }, { run: 'echo nope >&2; exit 4' }] })
evaluate('x', { environment: broken, timeout: '1s' }, async (t) => { await t.send('x') })
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
const env = defineEnvironment('remote', ({ skill }) => ({
  skills: [
    skill.git('${pathToFileURL(repo).href}', { ref: 'v1', path: 'skills', only: ['house-greeting'] }),
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
        'evals/o.eval.ts': `import { evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('e', { sandbox: ${sandbox} }, async () => {})
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
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({}),
  sandbox: docker({ install: ['apt-get update && apt-get install -y jq', { run: 'jq --version', timeout: '1m' }] }),
  judge: { model: fakeJudge() },
})
`,
      'docker/tools/Dockerfile': `ARG REEVAL_BASE\nFROM \${REEVAL_BASE}\nRUN echo tools\n`,
      'evals/py.Dockerfile': 'FROM python:3.12-slim\n',
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('default', async () => {})
evaluate('default again', async () => {})
evaluate('tools', { sandbox: docker({ dockerfile: '../docker/tools/Dockerfile' }) }, async () => {})
evaluate('py', { sandbox: docker({ dockerfile: new URL('./py.Dockerfile', import.meta.url) }) }, async () => {})
evaluate('from', { sandbox: docker({ from: 'python:3.12-slim', maxConcurrent: 2 }) }, async () => {})
evaluate('fake', { sandbox: (await import('reeval/sandbox')).fakeSandbox() }, async () => {})
`,
    })
    const r = await runCli(p.dir, ['image', 'build', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout
    assert.match(out, /^images {2}4 sandbox images \(nothing built: --dry-run\)$/m)
    // Each step's standing depends on what this machine has built, so only its shape is checked.
    const st = '[✓+~✗] '
    assert.match(
      out,
      new RegExp(
        `^docker \\+ install · 2 evals\\n {2}${st}base +reeval-sandbox:cursor-[\\d.]+ +\\((ready|to build|stale): .+\\)\\n {2}${st}install 2 commands +reeval-install:<base id \\+ commands> +\\(`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:tools · 1 eval\\n {2}${st}dockerfile docker/tools/Dockerfile +reeval-dockerfile:tools-<context \\+ reeval image id> +\\(.+\\)\\n {2}${st}harness +reeval-dockerfile:tools-<context \\+ reeval image id> +\\(`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:py\\.Dockerfile · 1 eval\\n {2}${st}dockerfile evals/py\\.Dockerfile +reeval-dockerfile:py-dockerfile-[0-9a-f]{16} .*\\n {2}${st}harness +reeval-sandbox:cursor-[\\d.]+-reeval-dockerfile-py-dockerfile-`,
        'm',
      ),
    )
    assert.match(
      out,
      new RegExp(
        `^docker:python:3\\.12-slim · 1 eval\\n {2}${st}from python:3\\.12-slim +reeval-sandbox:cursor-[\\d.]+-python-3-12-slim-[0-9a-f]{8}`,
        'm',
      ),
    )
    assert.doesNotMatch(out, /fake/)
    const runs = join(p.dir, '.reeval', 'runs')
    assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, 0, 'a dry run writes no run')
  })
})
