// Tier P: "given this config and these evals, the matrix is Y". Each case runs
// `es run --dry-run --json` on a directory under test/plan/ and compares the normalised matrix
// with test/plan/<dir>/expected/<case>.txt. ES_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import { matchFile, type PlanCase, planJson, renderPlan } from './support/plan.ts'

// biome-ignore lint/suspicious/noExportsInTest: the feature matrix reads this table (support/feature-matrix.ts)
export const cases: PlanCase[] = [
  { dir: 'matrix', name: 'default', args: [] },
  { dir: 'matrix', name: 'runs-override', args: ['--runs', '1'] },
  { dir: 'compare', name: 'control-and-variants', args: ['evals/variants.es.ts'] },
  { dir: 'compare', name: 'harness-scoped', args: ['evals/scoped.es.ts'] },
  { dir: 'compare', name: 'mixed-filter', args: ['evals/variants.es.ts', 'b/skilled'] },
  { dir: 'profiles', name: 'local-none', args: [] },
  { dir: 'profiles', name: 'pr-in-ci', args: [], env: { CI: 'true' } },
  { dir: 'profiles', name: 'nightly', args: ['--profile', 'nightly'] },
  { dir: 'selection', name: 'only-local', args: [] },
  { dir: 'selection', name: 'tags', args: ['--tag', 'slow', '--tag', '!flaky'] },
  { dir: 'images', name: 'install-from-dockerfile', args: [] },
  { dir: 'harnesses', name: 'claude-code', args: [] },
  { dir: 'antigravity', name: 'antigravity', args: [] },
  { dir: 'secrets', name: 'brokered', args: [] },
  { dir: 'egress', name: 'cascade', args: [] },
  { dir: 'egress', name: 'profile-defaults', args: ['--profile', 'locked', 'evals/cascade.es.ts'] },
]

describe('plan snapshots', { concurrency: true }, () => {
  for (const c of cases) {
    test(`${c.dir}: ${c.name}`, async () => {
      matchFile(`plan/${c.dir}/expected/${c.name}.txt`, renderPlan(await planJson(c)))
    })
  }
})

describe('the JSON plan', { concurrency: true }, () => {
  test('is one document with the host-dependent fields the snapshots leave out', async () => {
    const plan = await planJson({ dir: 'matrix', args: [] })
    assert.deepEqual(Object.keys(plan), [
      'profile',
      'totals',
      'budget',
      'concurrency',
      'estimateMs',
      'warnings',
      'hints',
      'evals',
      'excluded',
      'images',
    ])
    assert.ok(plan.concurrency >= 1)
    assert.equal(
      plan.estimateMs,
      plan.totals.attempts * 1000,
      'the fake agent is estimated at 1s an attempt',
    )
  })

  test('ES_PROFILE picks a profile, as --profile does', async () => {
    const plan = await planJson({ dir: 'profiles', args: [], env: { ES_PROFILE: 'nightly' } })
    assert.deepEqual(plan.profile, { name: 'nightly', reason: 'ES_PROFILE' })
  })

  test('.only in CI exits 2 before any plan prints', async () => {
    const p = await fixture('plan/selection')
    const r = await runCli(p.dir, ['run', '--dry-run', '--json'], { env: { CI: 'true' } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /evaluate\.only\/group\.only in evals\/only\.es\.ts isn't allowed in CI/)
  })

  test('an egress policy the sandbox cannot enforce exits 2 at plan time', async () => {
    const p = await fixture('plan/egress')
    const env = { ES_EGRESS_FAKE: '1' }
    for (const args of [['run', '--dry-run', '--json'], ['run']].map((a) => [
      ...a,
      'evals/cascade.es.ts',
    ])) {
      const r = await runCli(p.dir, args, { env })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.equal(r.stdout, '', args.join(' '))
      assert.match(
        r.stderr,
        /runs under egress \{ allow: \['config\.example\.com'\] \}, which needs a host allowlist \(config\.example\.com\), but the fake sandbox enforces no egress policy \(its commands run on the host\)\. Run it in docker\(\), or set egress: 'allow-all'\./,
      )
    }
    assert.deepEqual(readdirSync(p.dir).includes('.es'), false, 'nothing ran')
  })

  test('the text plan names each restricted policy and its automatic hosts', async () => {
    const p = await fixture('plan/egress')
    const r = await runCli(p.dir, ['run', '--dry-run', 'evals/auto.es.ts'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /egress: deny-all \+ auto: generativelanguage\.googleapis\.com, mcp\.example\.com/,
    )
    assert.match(r.stdout, /egress: allow api\.example\.com \+ auto: uploads\.example\.com/)
  })

  test("a cell filter narrows each row's counts in the text plan, not only the totals", async () => {
    const p = await fixture('plan/compare')
    const r = await runCli(p.dir, ['run', '--dry-run', 'evals/variants.es.ts', 'b/skilled'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /2 evals · 2 cells · 3 attempts/)
    const rows = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('evals/variants.es.ts'))
      .map((l) => l.split(/\s{2,}/).slice(1, 5))
    assert.deepEqual(rows, [
      ['1', '1 of 2', '1', '1'],
      ['1', '1', '2', '2'],
    ])
  })

  test('a filter part that matches no file, eval name or cell exits 2 and names it', async () => {
    const p = await fixture('plan/compare')
    for (const args of [
      ['evals/variants.es.ts', 'nosuchcell'],
      ['b/skilled', 'nosuchcell'],
    ]) {
      const r = await runCli(p.dir, ['run', '--dry-run', ...args])
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.equal(r.stdout, '')
      assert.match(
        r.stderr,
        /filter "nosuchcell" matches no eval file, eval name or cell in evals\/\*\*\/\*\.es\.ts/,
      )
    }
  })

  test('--json without --dry-run exits 2 with the fix', async () => {
    const p = await fixture('plan/matrix')
    const r = await runCli(p.dir, ['run', '--json'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /es run --json only prints the plan: add --dry-run/)
  })
})
