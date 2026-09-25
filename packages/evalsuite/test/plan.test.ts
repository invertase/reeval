// Tier P: "given this config and these evals, the matrix is Y". Each case runs
// `es run --dry-run --json` on a directory under test/plan/ and compares the normalised matrix
// with test/plan/<dir>/expected/<case>.txt. ES_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import { matchFile, type PlanCase, planJson, renderPlan } from './support/plan.ts'

const cases: PlanCase[] = [
  { dir: 'matrix', name: 'default', args: [] },
  { dir: 'matrix', name: 'runs-override', args: ['--runs', '1'] },
  { dir: 'compare', name: 'control-and-variants', args: ['evals/variants.es.ts'] },
  { dir: 'compare', name: 'harness-scoped', args: ['evals/scoped.es.ts'] },
  { dir: 'profiles', name: 'local-none', args: [] },
  { dir: 'profiles', name: 'pr-in-ci', args: [], env: { CI: 'true' } },
  { dir: 'profiles', name: 'nightly', args: ['--profile', 'nightly'] },
  { dir: 'selection', name: 'only-local', args: [] },
  { dir: 'selection', name: 'tags', args: ['--tag', 'slow', '--tag', '!flaky'] },
  { dir: 'images', name: 'install-from-dockerfile', args: [] },
  { dir: 'harnesses', name: 'claude-code', args: [] },
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

  test('--json without --dry-run exits 2 with the fix', async () => {
    const p = await fixture('plan/matrix')
    const r = await runCli(p.dir, ['run', '--json'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /es run --json only prints the plan: add --dry-run/)
  })
})
