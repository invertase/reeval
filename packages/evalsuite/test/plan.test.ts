// Tier P: "given this config and these evals, the matrix is Y". Each case runs
// `es run --dry-run --json` on a directory under test/plan/ and compares the normalised matrix
// with test/plan/<dir>/expected/<case>.txt. ES_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { describe, test } from 'node:test'
import { project, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import { matchFile, type PlanCase, planJson, renderPlan } from './support/plan.ts'

export const cases: PlanCase[] = [
  { dir: 'matrix', name: 'default', args: [] },
  { dir: 'matrix', name: 'runs-override', args: ['--runs', '1'] },
  { dir: 'compare', name: 'control-and-variants', args: ['evals/variants.es.ts'] },
  { dir: 'compare', name: 'harness-scoped', args: ['evals/scoped.es.ts'] },
  { dir: 'compare', name: 'mixed-filter', args: ['evals/variants.es.ts', 'b/skilled'] },
  { dir: 'compare', name: 'max-variants', args: ['--profile', 'lean', 'evals/limited.es.ts'] },
  { dir: 'profiles', name: 'local-none', args: [] },
  { dir: 'profiles', name: 'pr-in-ci', args: [], env: { CI: 'true' } },
  { dir: 'profiles', name: 'nightly', args: ['--profile', 'nightly'] },
  { dir: 'selection', name: 'only-local', args: [] },
  { dir: 'selection', name: 'tags', args: ['--tag', 'slow', '--tag', '!flaky'] },
  { dir: 'selection', name: 'group-and-eval-filter', args: ['slow things › big'] },
  { dir: 'images', name: 'install-from-dockerfile', args: [] },
  { dir: 'harnesses', name: 'claude-code', args: [] },
  { dir: 'antigravity', name: 'antigravity', args: [] },
  { dir: 'opencode', name: 'opencode', args: [] },
  { dir: 'goose', name: 'goose', args: [] },
  { dir: 'pi', name: 'pi', args: [] },
  { dir: 'codex', name: 'codex', args: [] },
  { dir: 'cursor', name: 'cursor', args: [] },
  { dir: 'secrets', name: 'brokered', args: [] },
  { dir: 'egress', name: 'cascade', args: [] },
  { dir: 'egress', name: 'profile-defaults', args: ['--profile', 'locked', 'evals/cascade.es.ts'] },
  { dir: 'privileges', name: 'levels', args: [] },
  { dir: 'privileges', name: 'profile', args: ['--profile', 'rooted'] },
  { dir: 'workspace', name: 'git', args: [] },
]

// Each case starts an `es` and its worker. All 25 at once swamp a small CI runner (Windows'
// has 4 CPUs) until each takes over 30 s; as many at a time as there are CPUs keeps each quick.
const CLIS = availableParallelism()

describe('plan snapshots', { concurrency: CLIS }, () => {
  for (const c of cases) {
    test(`${c.dir}: ${c.name}`, async () => {
      matchFile(`plan/${c.dir}/expected/${c.name}.txt`, renderPlan(await planJson(c)))
    })
  }
})

describe('the JSON plan', { concurrency: CLIS }, () => {
  test('is one document with the host-dependent fields the snapshots leave out', async () => {
    const plan = await planJson({ dir: 'matrix', args: [] })
    assert.deepEqual(Object.keys(plan), [
      'profile',
      'totals',
      'budget',
      'concurrency',
      'estimateMs',
      'warnings',
      'sandboxWarnings',
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

  test('an mcp.sse server on OpenCode, Goose, pi or Codex exits 2 at plan time, naming the eval and the server', async () => {
    for (const [factory, model, refusal] of [
      [
        'opencode',
        'gemini-3.8-flash',
        /evaluate\("streams"\) on opencode:gemini-3\.8-flash: OpenCode has no SSE MCP transport, so it can't use the events server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
      ],
      [
        'goose',
        'gemini-3.8-flash',
        /evaluate\("streams"\) on goose:gemini-3\.8-flash: Goose has no SSE MCP transport, so it can't use the events server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
      ],
      [
        'pi',
        'gemini-3.8-flash',
        /evaluate\("streams"\) on pi:gemini-3\.8-flash: pi has no MCP client, so it can't use the events MCP server/,
      ],
      [
        'codex',
        'gpt-5.4-mini',
        /evaluate\("streams"\) on codex:gpt-5\.4-mini: Codex has no SSE MCP transport, so it can't use the events server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
      ],
    ] as const) {
      const p = await project(`sse-${factory}`, {
        'es.config.ts': `import { defineConfig } from 'evalsuite'
import { cursor, ${factory} } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), ${factory}({ model: '${model}' })],
  sandbox: docker(),
})
`,
        'evals/s.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const events = defineEnvironment('events', ({ mcp }) => ({ mcp: { events: mcp.sse('https://events.example.com/sse') } }))
evaluate('streams', { environment: events }, async () => {})
`,
      })
      for (const args of [
        ['run', '--dry-run'],
        ['run', '--dry-run', '--json'],
      ]) {
        const r = await runCli(p.dir, args)
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.equal(r.stdout, '', args.join(' '))
        assert.match(r.stderr, refusal)
      }
    }
  })

  test('any MCP server on pi exits 2 at plan time; Goose takes stdio and http', async () => {
    const config = (factory: string) => `import { defineConfig } from 'evalsuite'
import { ${factory} } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({ harness: ${factory}({ model: 'gemini-3.8-flash' }), sandbox: docker() })
`
    const evals = `import { defineEnvironment, evaluate } from 'evalsuite'
const tools = defineEnvironment('tools', ({ mcp }) => ({
  mcp: { local: mcp.stdio('node', ['server.mjs']), remote: mcp.http('https://mcp.example.com/mcp') },
}))
evaluate('uses tools', { environment: tools }, async () => {})
`
    const pi = await project('mcp-pi', { 'es.config.ts': config('pi'), 'evals/m.es.ts': evals })
    const refused = await runCli(pi.dir, ['run', '--dry-run'])
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.match(
      refused.stderr,
      /evaluate\("uses tools"\) on pi:gemini-3\.8-flash: pi has no MCP client, so it can't use the local, remote MCP servers/,
    )
    // The twin: the same servers plan on a harness that has an MCP client.
    const goose = await project('mcp-goose', {
      'es.config.ts': config('goose'),
      'evals/m.es.ts': evals,
    })
    const planned = await runCli(goose.dir, ['run', '--dry-run'])
    assert.equal(planned.code, 0, planned.stdout + planned.stderr)
  })

  test('the text plan names each restricted policy and its automatic hosts', async () => {
    const p = await fixture('plan/egress')
    const r = await runCli(p.dir, ['run', '--dry-run', 'evals/auto.es.ts'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /egress: deny-all \+ auto: generativelanguage\.googleapis\.com, mcp\.example\.com, events\.example\.com$/m,
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

/** The root warning `es run` prints for the privileges fixture's eval-level sandbox. */
const ROOT_LINE =
  'WARNING: running as root in the sandbox: evaluate("installs deps") (docker({ root: true }))'

function assertRootWarning(output: string): void {
  assert.ok(output.split('\n').includes(ROOT_LINE), `no root warning in:\n${output}`)
}

describe('sandbox privilege warnings', { concurrency: CLIS }, () => {
  test('are structured in the JSON plan, one per level that set the sandbox', async () => {
    const plan = await planJson({ dir: 'privileges', args: [] })
    assert.deepEqual(plan.sandboxWarnings, [
      {
        kind: 'root',
        level: 'group',
        where: 'group("system packages")',
        file: 'evals/p.es.ts',
        message:
          'running as root in the sandbox: group("system packages") (docker({ root: true }))',
      },
      {
        kind: 'root',
        level: 'eval',
        where: 'evaluate("installs deps")',
        file: 'evals/p.es.ts',
        message:
          'running as root in the sandbox: evaluate("installs deps") (docker({ root: true }))',
      },
      {
        kind: 'capabilities',
        level: 'config',
        where: 'es.config.ts',
        file: null,
        capabilities: ['NET_RAW'],
        message:
          "extra capabilities in the sandbox: es.config.ts (docker({ capabilities: ['NET_RAW'] }))",
      },
      {
        kind: 'capabilities',
        level: 'eval',
        where: 'evaluate("installs deps")',
        file: 'evals/p.es.ts',
        capabilities: ['NET_ADMIN'],
        message:
          'extra capabilities in the sandbox: evaluate("installs deps") (docker({ capabilities: [\'NET_ADMIN\'] }))',
      },
    ])
  })

  test('print in the text plan, the agent output and as GitHub annotations', async () => {
    const p = await fixture('plan/privileges')
    const plain = await runCli(p.dir, ['run', '--dry-run', '--ui', 'plain'])
    assert.equal(plain.code, 0, plain.stdout + plain.stderr)
    assertRootWarning(plain.stdout)
    assert.match(
      plain.stdout,
      /^warning: extra capabilities in the sandbox: es\.config\.ts \(docker\(\{ capabilities: \['NET_RAW'\] \}\)\)$/m,
    )
    assert.doesNotMatch(plain.stdout, /^::warning/m, 'no annotations outside GitHub Actions')
    const agent = await runCli(p.dir, ['run', '--dry-run', '--ui', 'agent'])
    assertRootWarning(agent.stdout)
    const gh = await runCli(p.dir, ['run', '--dry-run', '--ui', 'plain'], {
      env: { GITHUB_ACTIONS: 'true' },
    })
    assertRootWarning(gh.stdout)
    assert.match(
      gh.stdout,
      /^::warning file=evals\/p\.es\.ts,title=Sandbox runs as root::running as root in the sandbox: evaluate\("installs deps"\) \(docker\(\{ root: true \}\)\)$/m,
    )
    assert.match(
      gh.stdout,
      /^::warning title=Sandbox has extra capabilities::extra capabilities in the sandbox: es\.config\.ts/m,
    )
  })

  test('canary: an eval without root gets no warning, so the check fails', async () => {
    const p = await fixture('plan/privileges')
    const r = await runCli(p.dir, ['run', '--dry-run', '--ui', 'plain', 'stays unprivileged'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.throws(() => assertRootWarning(r.stdout), /no root warning/)
    assert.doesNotMatch(r.stdout, /WARNING|warning:/)
    const plan = await planJson({ dir: 'privileges', args: ['stays unprivileged'] })
    assert.deepEqual(plan.sandboxWarnings, [])
  })
})
