// Tier P: "given this config and these evals, the matrix is Y". Each case runs
// `reeval run --dry-run --json` on a directory under test/plan/ and compares the normalised matrix
// with test/plan/<dir>/expected/<case>.txt. REEVAL_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { describe, test } from 'node:test'
import { VERCEL_GATEWAY } from '../src/gateway/vercel.ts'
import { fakeConfig, project, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import { matchFile, type PlanCase, planJson, renderPlan } from './support/plan.ts'
import { syncPythonFixtureProject } from './support/python-fixture.ts'

/** The plan as on a host without Docker, whose image stages name the tags they'd build. */
const NO_DOCKER = { DOCKER_HOST: 'unix:///nonexistent/reeval-plan.sock' }
/** The cost cases' Composer price, over a models.dev cache in the project, so none fetches it. */
const PRICES = { REEVAL_PRICES: 'prices.json', XDG_CACHE_HOME: '.cache' }
const modelsDev = async (dir: string) => {
  const { seedModelsDev } = await import('./support/cost.ts')
  seedModelsDev(dir)
}

export const cases: PlanCase[] = [
  { dir: 'matrix', name: 'default', args: [] },
  { dir: 'matrix', name: 'runs-override', args: ['--runs', '1'] },
  { dir: 'compare', name: 'control-and-variants', args: ['evals/variants.eval.ts'] },
  { dir: 'compare', name: 'independent', args: ['evals/independent.eval.ts'] },
  { dir: 'compare', name: 'baseline-omitted', args: ['evals/omitted.eval.ts'] },
  {
    dir: 'compare',
    name: 'baseline-omitted-off',
    args: ['--profile', 'off', 'evals/omitted.eval.ts'],
  },
  { dir: 'compare', name: 'harness-scoped', args: ['evals/scoped.eval.ts'] },
  { dir: 'compare', name: 'each-pooled', args: ['evals/each.eval.ts'] },
  { dir: 'compare', name: 'each-filtered', args: ['evals/each.eval.ts', 'grace'] },
  { dir: 'compare', name: 'mixed-filter', args: ['evals/variants.eval.ts', 'b/skilled'] },
  { dir: 'compare', name: 'study', args: ['evals/study.eval.ts'] },
  { dir: 'compare', name: 'max-variants', args: ['--profile', 'lean', 'evals/limited.eval.ts'] },
  { dir: 'compare', name: 'off-study', args: ['--profile', 'off', 'evals/study.eval.ts'] },
  { dir: 'compare', name: 'zero-variants', args: ['--profile', 'none', 'evals/limited.eval.ts'] },
  { dir: 'compare', name: 'questions', args: ['evals/questions.eval.ts'] },
  {
    dir: 'compare',
    name: 'questions-dropped',
    args: ['--profile', 'off', 'evals/questions.eval.ts'],
  },
  { dir: 'compare', name: 'questions-group', args: ['evals/questions-group.eval.ts'] },
  { dir: 'compare', name: 'questions-across', args: ['evals/questions-across.eval.ts'] },
  { dir: 'compare', name: 'questions-state', args: ['evals/questions-state.eval.ts'] },
  { dir: 'compare', name: 'questions-model', args: ['evals/questions-model.eval.ts'] },
  {
    dir: 'compare',
    name: 'questions-profile-judge',
    args: ['--profile', 'judged', 'evals/questions.eval.ts'],
  },
  { dir: 'compare', name: 'questions-attempts', args: ['evals/questions-attempts.eval.ts'] },
  {
    dir: 'compare',
    name: 'questions-one-harness',
    args: ['--profile', 'one', 'evals/questions-attempts.eval.ts'],
  },
  { dir: 'insights', name: 'insights', args: [] },
  { dir: 'insights', name: 'no-insights', args: ['--no-insights'] },
  {
    dir: 'insights',
    name: 'anthropic-no-key',
    args: ['--config', 'reeval.anthropic.config.ts'],
  },
  {
    dir: 'insights',
    name: 'anthropic-key',
    args: ['--config', 'reeval.anthropic.config.ts'],
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' },
  },
  { dir: 'profiles', name: 'local-none', args: [] },
  { dir: 'profiles', name: 'pr-in-ci', args: [], env: { CI: 'true' } },
  { dir: 'profiles', name: 'nightly', args: ['--profile', 'nightly'] },
  { dir: 'oracle', name: 'oracle', args: ['--profile', 'oracle'] },
  { dir: 'oracle', name: 'canary', args: ['--profile', 'canary'] },
  { dir: 'yaml', name: 'default', args: [] },
  { dir: 'yaml', name: 'pr-in-ci', args: [], env: { CI: 'true' } },
  { dir: 'yaml', name: 'nightly', args: ['--profile', 'nightly'] },
  { dir: 'yaml', name: 'config-flag', args: ['--config', 'reeval.staging.yml'] },
  { dir: 'yaml-paths', name: 'from-above', args: ['--config', 'project/reeval.yaml'] },
  {
    dir: 'yaml-paths',
    name: 'profile-from-above',
    args: ['--config', 'project/reeval.yaml', '--profile', 'nightly'],
  },
  { dir: 'ts-paths', name: 'from-above', args: ['--config', 'project/reeval.config.ts'] },
  {
    dir: 'ts-paths',
    name: 'profile-from-above',
    args: ['--config', 'project/reeval.config.ts', '--profile', 'nightly'],
  },
  {
    dir: 'tree-paths',
    name: 'tree-from-above',
    args: ['--config', 'project/reeval.config.ts', 'tree.eval'],
  },
  {
    dir: 'tree-paths',
    name: 'helpers-from-above',
    args: ['--config', 'project/reeval.config.ts', 'helpers.eval'],
  },
  {
    dir: 'python',
    name: 'hello',
    args: ['hello.eval'],
    prepare: (dir) => syncPythonFixtureProject(dir),
  },
  {
    dir: 'python',
    name: 'dataclass-future',
    args: ['dataclass-future.eval'],
    prepare: (dir) => syncPythonFixtureProject(dir),
  },
  { dir: 'gateway', name: 'default', args: ['--config', 'reeval.default.config.ts'] },
  { dir: 'gateway', name: 'listed', args: [] },
  {
    dir: 'gateway',
    name: 'profile-list',
    args: ['--config', 'reeval.default.config.ts', '--profile', 'listed'],
  },
  { dir: 'gateway', name: 'profile-pin', args: ['--profile', 'pinned'] },
  { dir: 'gateway', name: 'yaml', args: ['--config', 'reeval.data.yaml'] },
  { dir: 'gateway', name: 'vercel', args: ['--config', 'reeval.vercel.config.ts'] },
  {
    dir: 'gateway',
    name: 'vercel-pin',
    args: ['--config', 'reeval.vercel.config.ts', '--profile', 'codex-pin'],
  },
  { dir: 'gateway', name: 'vercel-yaml', args: ['--config', 'reeval.vercel.yaml'] },
  { dir: 'gateway', name: 'openrouter', args: ['--config', 'reeval.openrouter.config.ts'] },
  {
    dir: 'gateway',
    name: 'openrouter-fallbacks',
    args: ['--config', 'reeval.openrouter.config.ts', '--profile', 'fallbacks'],
  },
  { dir: 'gateway', name: 'openrouter-yaml', args: ['--config', 'reeval.openrouter.yaml'] },
  { dir: 'selection', name: 'only-local', args: [] },
  { dir: 'selection', name: 'tags', args: ['--tag', 'slow', '--tag', '!flaky'] },
  { dir: 'selection', name: 'group-and-eval-filter', args: ['slow things › big'] },
  { dir: 'images', name: 'install-from-dockerfile', args: ['evals/i.eval.ts'], env: NO_DOCKER },
  { dir: 'images', name: 'plugin-builds', args: ['evals/plugins.eval.ts'], env: NO_DOCKER },
  { dir: 'harnesses', name: 'claude-code', args: [] },
  { dir: 'harness-edits', name: 'data-and-functions', args: [] },
  { dir: 'antigravity', name: 'antigravity', args: [] },
  { dir: 'opencode', name: 'opencode', args: [] },
  { dir: 'opencode', name: 'bedrock-region', args: ['Bedrock'], env: { AWS_REGION: 'eu-west-1' } },
  { dir: 'goose', name: 'goose', args: [] },
  { dir: 'pi', name: 'pi', args: [] },
  { dir: 'codex', name: 'codex', args: [] },
  { dir: 'grok-build', name: 'grok-build', args: [] },
  { dir: 'fx', name: 'fx', args: [] },
  { dir: 'cursor', name: 'cursor', args: [] },
  { dir: 'effort', name: 'effort', args: [] },
  { dir: 'secrets', name: 'brokered', args: [] },
  { dir: 'egress', name: 'cascade', args: ['evals/auto.eval.ts', 'evals/cascade.eval.ts'] },
  {
    dir: 'egress',
    name: 'profile-defaults',
    args: ['--profile', 'locked', 'evals/cascade.eval.ts'],
  },
  {
    dir: 'egress',
    name: 'default-proxy',
    args: ['--config', 'reeval.default.config.ts', 'evals/direct.eval.ts'],
  },
  {
    dir: 'egress',
    name: 'allow-all-on-ci',
    args: ['--config', 'reeval.default.config.ts', 'evals/direct.eval.ts'],
    env: { GITHUB_ACTIONS: 'true' },
  },
  { dir: 'privileges', name: 'levels', args: [] },
  { dir: 'privileges', name: 'profile', args: ['--profile', 'rooted'] },
  { dir: 'workspace', name: 'git', args: [] },
  { dir: 'files', name: 'directory', args: [] },
  { dir: 'plugins', name: 'parts', args: ['evals/parts.eval.ts'] },
  { dir: 'plugins', name: 'remote', args: ['evals/remote.eval.ts'] },
  { dir: 'plugins', name: 'fetches-at-start', args: ['evals/fetches.eval.ts'] },
  { dir: 'plugins', name: 'marketplace', args: ['evals/marketplace.eval.ts'] },
  {
    dir: 'plugins',
    name: 'claude-code-and-grok-build',
    args: ['--config', 'reeval.claude-grok.config.ts', 'evals/namespaced.eval.ts'],
  },
  {
    dir: 'plugins',
    name: 'antigravity-and-cursor',
    args: ['--config', 'reeval.antigravity-cursor.config.ts', 'evals/every-part.eval.ts'],
  },
  {
    dir: 'plugins',
    name: 'opencode-pi-and-fx',
    args: ['--config', 'reeval.opencode-pi-fx.config.ts', 'evals/unpacked.eval.ts'],
  },
  {
    dir: 'plugins',
    name: 'codex-and-goose',
    args: ['--config', 'reeval.codex-goose.config.ts', 'evals/skills-and-mcp.eval.ts'],
  },
  { dir: 'capture', name: 'options', args: [] },
  { dir: 'environments', name: 'images', args: ['evals/images.eval.ts'] },
  { dir: 'environments', name: 'podman', args: ['evals/podman.eval.ts'] },
  { dir: 'environments', name: 'extend-replace', args: ['evals/extend.eval.ts'] },
  { dir: 'environments', name: 'config-control', args: ['evals/compare.eval.ts'] },
  { dir: 'environments', name: 'inherit-config', args: ['evals/inherit.eval.ts'] },
  {
    dir: 'environments',
    name: 'empty-control',
    args: ['--config', 'reeval.empty.config.ts', 'evals/empty.eval.ts'],
  },
  { dir: 'cost', name: 'no-history', args: [], cost: true, env: PRICES, prepare: modelsDev },
  {
    dir: 'cost',
    name: 'history',
    args: [],
    cost: true,
    env: PRICES,
    async prepare(dir) {
      await modelsDev(dir)
      const { writePastCostRuns } = await import('./support/cost.ts')
      writePastCostRuns(dir)
    },
  },
  {
    dir: 'cost',
    name: 'unpriced',
    args: ['--config', 'reeval.unpriced.config.ts'],
    cost: true,
    env: PRICES,
    prepare: modelsDev,
  },
  {
    dir: 'cost',
    name: 'file-offline',
    args: [],
    cost: true,
    env: PRICES,
    async prepare(dir) {
      const { seedModelsDevFailure } = await import('./support/cost.ts')
      seedModelsDevFailure(dir)
    },
  },
  { dir: 'cost', name: 'tokens-only', args: [], cost: true },
  {
    dir: 'resume',
    name: 'stopped-staging',
    args: ['--resume'],
    async prepare(dir) {
      const { writeStoppedStaging } = await import('./support/resume.ts')
      writeStoppedStaging(dir, '20260101T000000Z_nogit_test_abcd', [
        { file: 'evals/r.eval.ts', name: 'done', cell: 'fake/-/docker' },
      ])
    },
  },
]

// Each case starts an `reeval` and its worker. All 25 at once swamp a small CI runner (Windows'
// has 4 CPUs) until each takes over 30 s; as many at a time as there are CPUs keeps each quick.
const CLIS = availableParallelism()

describe('plan snapshots', { concurrency: CLIS }, () => {
  for (const c of cases) {
    test(`${c.dir}: ${c.name}`, async () => {
      matchFile(
        `plan/${c.dir}/expected/${c.name}.txt`,
        renderPlan(await planJson(c), { cost: c.cost ?? false }),
      )
    })
  }
})

describe('the JSON plan', { concurrency: CLIS }, () => {
  test('is one document with the host-dependent fields the snapshots leave out', async () => {
    const plan = await planJson({ dir: 'matrix', args: [] })
    assert.deepEqual(Object.keys(plan), [
      'runId',
      'profile',
      'totals',
      'budget',
      'concurrency',
      'estimateMs',
      'cost',
      'warnings',
      'sandboxWarnings',
      'hints',
      'insights',
      'evals',
      'excluded',
      'images',
    ])
    assert.match(plan.runId ?? '', /^\d{8}T\d{6}Z_/)
    assert.ok(plan.concurrency >= 1)
    assert.equal(
      plan.estimateMs,
      plan.totals.attempts * 30_000,
      'the fake agent in a Docker sandbox is estimated at its 30s setup an attempt',
    )
  })

  test('with no history, the fake agent in the fake sandbox is estimated at 1s an attempt', async () => {
    const plan = await planJson({ dir: 'profiles', args: [] })
    assert.ok(plan.totals.attempts > 0)
    assert.equal(plan.estimateMs, plan.totals.attempts * 1000)
  })

  test('REEVAL_PROFILE picks a profile, as --profile does', async () => {
    const plan = await planJson({ dir: 'profiles', args: [], env: { REEVAL_PROFILE: 'nightly' } })
    assert.deepEqual(plan.profile, { name: 'nightly', reason: 'REEVAL_PROFILE' })
  })

  test("each cell's gateway is in the JSON plan when the config lists one", async () => {
    const plan = await planJson({ dir: 'gateway', args: [] })
    for (const e of plan.evals) {
      assert.deepEqual(e.cells[0]?.gateway, { name: 'direct', skipped: [] }, e.name)
    }
    const unset = await planJson({ dir: 'gateway', args: ['--config', 'reeval.default.config.ts'] })
    assert.equal(unset.evals.find((e) => e.name === 'greets')?.cells[0]?.gateway, undefined)
    const vercel = await planJson({ dir: 'gateway', args: ['--config', 'reeval.vercel.config.ts'] })
    const cells = vercel.evals.find((e) => e.name === 'greets')?.cells ?? []
    assert.deepEqual(
      cells.map((c) => [c.harness, c.gateway]),
      [
        ['claude-code:claude-sonnet-4-5', { name: 'vercel', skipped: [] }],
        ['codex:gpt-5.4-mini', { name: 'vercel', skipped: [] }],
        [
          'cursor:composer-2.5',
          {
            name: 'direct',
            skipped: [{ gateway: 'vercel', why: "Cursor's agent only calls Cursor's own API" }],
          },
        ],
        ['goose:gemini-3.8-flash', { name: 'vercel', skipped: [] }],
        [
          'pi:gemini-3.8-flash',
          { name: 'direct', skipped: [{ gateway: 'vercel', why: VERCEL_GATEWAY.refusals.pi }] },
        ],
        ['grok-build:grok-4.6', { name: 'vercel', skipped: [] }],
      ],
    )
  })

  test('a gateway reeval does not know exits 2 at plan time, naming the ones it does', async () => {
    const p = await project('gateway-unknown', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
export default defineConfig({ harness: fakeHarness(), gateway: [{ kind: 'vercell' }] })
`,
      'evals/g.eval.ts': `import { evaluate } from 'reeval'
evaluate('unknown', async () => {})
`,
    })
    for (const args of [['run', '--dry-run'], ['run']]) {
      const r = await runCli(p.dir, args)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /gateway\[0\] in reeval\.config\.ts is "vercell", which isn't a gateway reeval knows: 'direct' or 'vercel' or 'openrouter'\. Did you mean 'vercel'\?/,
      )
    }
    assert.deepEqual(readdirSync(p.dir).includes('.reeval'), false, 'nothing ran')
  })

  test('a judge model no listed gateway serves exits 2 at plan time, naming the one that would', async () => {
    const p = await project('gateway-judge', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { direct } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
export default defineConfig({
  harness: fakeHarness(),
  gateway: [direct()],
  judge: { model: 'mistral/large' },
})
`,
      'evals/g.eval.ts': `import { evaluate } from 'reeval'
evaluate('judged', async () => {})
`,
    })
    const r = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /evals\/g\.eval\.ts: evaluate\("judged"\): the judge model "mistral\/large": no gateway in the list can serve it \(direct: .*\)\. Add vercel\(\) to gateway\./,
    )
  })

  test('.only in CI exits 2 before any plan prints', async () => {
    const p = await fixture('plan/selection')
    const r = await runCli(p.dir, ['run', '--dry-run', '--json'], { env: { CI: 'true' } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.equal(r.stdout, '')
    assert.match(
      r.stderr,
      /evaluate\.only\/group\.only in evals\/only\.eval\.ts isn't allowed in CI/,
    )
  })

  test('an egress policy the sandbox cannot enforce exits 2 at plan time', async () => {
    const p = await fixture('plan/egress')
    const env = { REEVAL_EGRESS_FAKE: '1' }
    for (const args of [['run', '--dry-run', '--json'], ['run']].map((a) => [
      ...a,
      'evals/cascade.eval.ts',
    ])) {
      const r = await runCli(p.dir, args, { env })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.equal(r.stdout, '', args.join(' '))
      assert.match(
        r.stderr,
        /runs under egress \{ allow: \['config\.example\.com'\] \}, which needs a host allowlist \(config\.example\.com\), but the fake sandbox enforces no egress policy \(its commands run on the host\)\. Run it in docker\(\), or set egress: 'allow-all'\./,
      )
    }
    assert.deepEqual(readdirSync(p.dir).includes('.reeval'), false, 'nothing ran')
  })

  test("OpenCode on a provider direct() can't broker exits 2 at plan time, naming it and why", async () => {
    for (const [where, model, refusal, env] of [
      [
        'config',
        'google-vertex/gemini-3.8-flash',
        /on opencode:gemini-3\.8-flash: no gateway in the list can serve it \(direct: reeval can't run OpenCode on Vertex \(google-vertex\): it takes a service account \(Vertex refuses API keys for most models\), not a key in a header, so the gateway can't keep its key out of the sandbox/,
      ],
      [
        'config',
        'amazon-bedrock/global.anthropic.claude-haiku-4-5',
        /\(direct: AWS_REGION is "evil\.example\.com\/x", which isn't one Amazon Bedrock \(amazon-bedrock\) takes: OpenCode builds its API's host from it, so it must match/,
        { AWS_REGION: 'evil.example.com/x' },
      ],
      [
        'eval',
        'lmstudio/qwen3-coder',
        /\(direct: reeval can't run OpenCode on LMStudio \(lmstudio\): it runs on your machine, and the sandbox can't reach the host's localhost/,
      ],
      [
        'eval',
        'gemini-3.8-flash',
        /opencode\(\): an OpenCode model id names its provider, <provider>\/<model>/,
      ],
    ] as const) {
      const harness = `opencode({ model: '${model}' })`
      const p = await project(`refused-${where}-${model.split('/')[0]}${env ? '-env' : ''}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor, opencode } from 'reeval/harness'
export default defineConfig({
  harness: ${where === 'config' ? harness : "cursor({ model: 'composer-2.5' })"},
})
`,
        'evals/r.eval.ts': `import { evaluate } from 'reeval'
import { opencode } from 'reeval/harness'
evaluate('refused', ${where === 'eval' ? `{ harness: ${harness} }, ` : ''}async () => {})
`,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'], { env: env ?? {} })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, refusal)
      assert.deepEqual(readdirSync(p.dir).includes('.reeval'), false, 'nothing ran')
    }
  })

  test('an mcp.sse server on OpenCode, Goose, pi or Codex exits 2 at plan time, naming the eval and the server', async () => {
    for (const [factory, model, refusal] of [
      [
        'opencode',
        'google/gemini-3.8-flash',
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
        /evaluate\("streams"\) on pi:gemini-3\.8-flash: pi has no SSE MCP transport, so it can't use the events server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
      ],
      [
        'codex',
        'gpt-5.4-mini',
        /evaluate\("streams"\) on codex:gpt-5\.4-mini: Codex has no SSE MCP transport, so it can't use the events server \(mcp\.sse\): use mcp\.http or mcp\.stdio/,
      ],
    ] as const) {
      const p = await project(`sse-${factory}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor, ${factory} } from 'reeval/harness'
export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), ${factory}({ model: '${model}' })],
})
`,
        'evals/s.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
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

  test('pi and Goose take stdio and http MCP servers; pi exits 2 on a server name it would skip', async () => {
    const config = (factory: string) => `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: 'gemini-3.8-flash' }) })
`
    const evals = (local: string) => `import { defineEnvironment, evaluate } from 'reeval'
const tools = defineEnvironment('tools', ({ mcp }) => ({
  mcp: { '${local}': mcp.stdio('node', ['server.mjs']), remote: mcp.http('https://mcp.example.com/mcp') },
}))
evaluate('uses tools', { environment: tools }, async () => {})
`
    for (const factory of ['pi', 'goose']) {
      const p = await project(`mcp-${factory}`, {
        'reeval.config.ts': config(factory),
        'evals/m.eval.ts': evals('local'),
      })
      const planned = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(planned.code, 0, `${factory}: ${planned.stdout}${planned.stderr}`)
    }
    // The twin: the same servers, one named with a dot, which pi would skip.
    const dotted = await project('mcp-pi-dotted', {
      'reeval.config.ts': config('pi'),
      'evals/m.eval.ts': evals('my.local'),
    })
    const refused = await runCli(dotted.dir, ['run', '--dry-run'])
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.match(
      refused.stderr,
      /evaluate\("uses tools"\) on pi:gemini-3\.8-flash: pi takes MCP server names of letters, digits, "_" and "-" only, so it can't use the my\.local server: rename it/,
    )
  })

  test("Claude Code and Grok Build refuse a plugin's rules, and a plugin MCP server's host secret", async () => {
    const plugin = {
      'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
      'plugins/review/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n',
      'plugins/review/rules/style.md': 'Write small functions.\n',
      'plugins/review/.mcp.json': JSON.stringify({
        mcpServers: { docs: { command: 'docs-server', env: { DOCS_TOKEN: `${'$'}{DOCS_TOKEN}` } } },
      }),
    }
    for (const [factory, model, id, name] of [
      ['claudeCode', 'claude-sonnet-5', 'claude-code', 'Claude Code'],
      ['grokBuild', 'grok-4.6', 'grok-build', 'Grok Build'],
    ] as const) {
      for (const [label, only, refusal] of [
        [
          'rules',
          '',
          `${name} can't load the review plugin's rules \\(rules/\\): use only: \\['skills', 'mcp'\\], or leave the plugin out of this cell`,
        ],
        [
          'secret',
          "{ only: ['skills', 'mcp'] }",
          `${name} loads the review plugin's MCP server "docs" itself, so reeval can't give it DOCS_TOKEN from the host: use only: \\['skills'\\] and declare the server in mcp, where reeval fills it in`,
        ],
      ] as const) {
        const p = await project(`plugin-namespaced-${factory}-${label}`, {
          'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
          'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin }) => ({ plugins: [plugin.local('../plugins/review'${only ? `, ${only}` : ''})] }))
evaluate('reviews', { environment: review }, async () => {})
`,
          ...plugin,
        })
        const r = await runCli(p.dir, ['run', '--dry-run'])
        assert.equal(r.code, 2, `${factory} ${label}: ${r.stdout}${r.stderr}`)
        assert.match(
          r.stderr,
          new RegExp(`evaluate\\("reviews"\\) on ${id}:[^:]+: ${refusal}`),
          `${factory} ${label}`,
        )
      }
    }
  })

  test("Codex refuses a plugin's hooks and its apps; Goose a plugin's hooks", async () => {
    const plugin = {
      'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
      'plugins/review/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n',
      'plugins/review/hooks/hooks.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] },
      }),
      'plugins/chat/.claude-plugin/plugin.json': '{ "name": "chat" }',
      'plugins/chat/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n',
      'plugins/chat/.app.json': '{ "apps": {} }',
    }
    for (const [factory, model, name, dir, refusal] of [
      [
        'codex',
        'gpt-5.4-mini',
        'Codex',
        'review',
        "Codex can't load the review plugin's hooks \\(hooks/hooks.json\\): use only: \\['skills'\\], or leave the plugin out of this cell",
      ],
      [
        'codex',
        'gpt-5.4-mini',
        'Codex',
        'chat',
        "Codex can't load the chat plugin's apps: they need a ChatGPT login",
      ],
      [
        'goose',
        'gemini-3.8-flash',
        'Goose',
        'review',
        "Goose can't load the review plugin's hooks \\(hooks/hooks.json\\): use only: \\['skills'\\], or leave the plugin out of this cell",
      ],
    ] as const) {
      const p = await project(`plugin-${factory}-${dir}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin }) => ({ plugins: [plugin.local('../plugins/${dir}')] }))
evaluate('reviews', { environment: review }, async () => {})
`,
        ...plugin,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${name} ${dir}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, new RegExp(`evaluate\\("reviews"\\) on ${factory}:[^:]+: ${refusal}`))
    }
  })

  test("Grok Build and Codex refuse a plugin MCP server named like one in mcp; Claude Code's namespaced name plans", async () => {
    for (const [factory, model, refused] of [
      ['grokBuild', 'grok-4.6', 'grok-build:[^:]+: Grok Build'],
      ['codex', 'gpt-5.4-mini', 'codex:[^:]+: Codex'],
      ['claudeCode', 'claude-sonnet-5', undefined],
    ] as const) {
      const p = await project(`plugin-server-name-${factory}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin, mcp }) => ({
  mcp: { docs: mcp.stdio('docs-server') },
  plugins: [plugin.local('../plugins/review')],
}))
evaluate('reviews', { environment: review }, async () => {})
`,
        'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
        'plugins/review/.mcp.json': JSON.stringify({
          mcpServers: { docs: { command: 'docs-server' } },
        }),
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      if (!refused) {
        assert.equal(r.code, 0, `${factory}: ${r.stdout}${r.stderr}`)
        continue
      }
      assert.equal(r.code, 2, `${factory}: ${r.stdout}${r.stderr}`)
      assert.match(
        r.stderr,
        new RegExp(
          `evaluate\\("reviews"\\) on ${refused} names the review plugin's MCP server "docs" by its own name, as it does mcp\\.docs, and keeps only one: rename one, or leave mcp out of the plugin with only`,
        ),
      )
    }
  })

  test("Goose refuses a plugin MCP server it keys like one in mcp; Claude Code's namespaced name plans", async () => {
    for (const [factory, model, refused] of [
      ['goose', 'gemini-3.8-flash', true],
      ['claudeCode', 'claude-sonnet-5', false],
    ] as const) {
      const p = await project(`plugin-server-key-${factory}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin, mcp }) => ({
  mcp: { review_docs: mcp.stdio('docs-server') },
  plugins: [plugin.local('../plugins/review')],
}))
evaluate('reviews', { environment: review }, async () => {})
`,
        'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
        'plugins/review/.mcp.json': JSON.stringify({
          mcpServers: { docs: { command: 'docs-server' } },
        }),
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      if (!refused) {
        assert.equal(r.code, 0, `${factory}: ${r.stdout}${r.stderr}`)
        continue
      }
      assert.equal(r.code, 2, `${factory}: ${r.stdout}${r.stderr}`)
      assert.match(
        r.stderr,
        /evaluate\("reviews"\) on goose:[^:]+: Goose keys the review_docs and review:docs MCP servers both as review_docs, and keeps only one: rename one/,
      )
    }
  })

  test('OpenCode, pi and fx refuse the plugin parts they have no place for, and pi a plugin server named like one in mcp', async () => {
    const files = {
      'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
      'plugins/review/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n',
      'plugins/review/agents/reviewer.md': 'Review.\n',
      'plugins/review/commands/ship.md': 'Ship.\n',
      'plugins/review/rules/style.md': 'Write small functions.\n',
      'plugins/review/.mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }),
    }
    for (const [i, [factory, model, environment, refusal]] of (
      [
        [
          'opencode',
          'google/gemini-3.8-flash',
          "{ plugins: [plugin.local('../plugins/review')] }",
          "OpenCode can't load the review plugin's rules \\(rules/\\): use only: \\['skills', 'agents', 'commands', 'mcp'\\], or leave the plugin out of this cell",
        ],
        [
          'pi',
          'gemini-3.8-flash',
          "{ plugins: [plugin.local('../plugins/review')] }",
          "pi can't load the review plugin's agents \\(agents/\\) and rules \\(rules/\\): use only: \\['skills', 'commands', 'mcp'\\], or leave the plugin out of this cell",
        ],
        [
          'fx',
          'gpt-4.1',
          "{ plugins: [plugin.local('../plugins/review')] }",
          "fx can't load the review plugin's agents \\(agents/\\) and commands \\(commands/\\) and rules \\(rules/\\): use only: \\['skills', 'mcp'\\], or leave the plugin out of this cell",
        ],
        [
          'pi',
          'gemini-3.8-flash',
          "{ mcp: { review_docs: mcp.stdio('docs') }, plugins: [plugin.local('../plugins/review', { only: ['mcp'] })] }",
          'pi names the review:docs MCP server review_docs, as it does the review_docs server, and keeps only one: rename one',
        ],
      ] as const
    ).entries()) {
      const p = await project(`plugin-unpacked-${i}-${factory}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ mcp, plugin }) => (${environment}))
evaluate('reviews', { environment: review }, async () => {})
`,
        ...files,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${factory}: ${r.stdout}${r.stderr}`)
      assert.equal(r.stdout, '', factory)
      assert.match(
        r.stderr,
        new RegExp(`evaluate\\("reviews"\\) on ${factory}:[^:]+: ${refusal}`),
        factory,
      )
    }
  })

  test('Cursor refuses a plugin item that clashes where it unpacks or places it, and a hook event it doesn’t run', async () => {
    const plugin = (name: string, files: Record<string, string>) =>
      Object.fromEntries([
        [`plugins/${name}/.claude-plugin/plugin.json`, `{ "name": "${name}" }`],
        ...Object.entries(files).map(([path, content]) => [`plugins/${name}/${path}`, content]),
      ])
    const skill = '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n'
    for (const [label, files, environment, refusal] of [
      [
        'skill',
        { ...plugin('review', { 'skills/lint/SKILL.md': skill }), 'skills/lint/SKILL.md': skill },
        "{ skills: [skill.local('../skills/lint')], plugins: [plugin.local('../plugins/review')] }",
        `the review plugin's skill "lint" and skill\\.local\\('skills/lint'\\)'s "lint" would both be placed at ~/\\.agents/skills/lint: rename one, or narrow it with only or exclude`,
      ],
      [
        'subagent',
        {
          ...plugin('review', { 'agents/reviewer.md': 'Review.\n' }),
          ...plugin('audit', { 'agents/reviewer.md': 'Audit.\n' }),
        },
        "{ plugins: [plugin.local('../plugins/review'), plugin.local('../plugins/audit')] }",
        `the audit plugin's subagent "reviewer" and the review plugin's would both be placed at \\.cursor/agents/reviewer\\.md: rename one, or narrow one with only`,
      ],
      [
        'hook',
        plugin('review', {
          'commands/review.md': 'Review.\n',
          'hooks/hooks.json': JSON.stringify({
            hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
          }),
        }),
        "{ plugins: [plugin.local('../plugins/review')] }",
        `Cursor can't run the review plugin's Notification hooks \\(hooks/hooks\\.json\\): it runs SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStop, PreCompact, Stop hooks; use only: \\['commands'\\], or leave the plugin out of this cell`,
      ],
    ] as const) {
      const p = await project(`plugin-cursor-clash-${label}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin, skill }) => (${environment}))
evaluate('reviews', { environment: review }, async () => {})
`,
        ...files,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${label}: ${r.stdout}${r.stderr}`)
      assert.equal(r.stdout, '', label)
      assert.match(
        r.stderr,
        new RegExp(`evaluate\\("reviews"\\) on cursor:[^:]+: ${refusal}`),
        label,
      )
      assert.deepEqual(readdirSync(p.dir).includes('.reeval'), false, `${label}: nothing ran`)
    }
  })

  test('a plugin the plan reads and refuses exits 2: no manifest, a build outside Docker, npx under deny-all', async () => {
    const config = `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: fakeHarness(), sandbox: docker({ from: 'node:22-bookworm' }) })
`
    for (const [label, call, files, options, refusal] of [
      [
        'no-manifest',
        "plugin.local('../plugins/bare')",
        { 'plugins/bare/skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\n' },
        undefined,
        /evaluate\("uses it"\) on fake: plugin\.local\('plugins\/bare'\) has no \.claude-plugin\/plugin\.json/,
      ],
      [
        'build',
        "plugin.local('../plugins/fetcher', { build: 'npm ci' })",
        {},
        ', sandbox: fakeSandbox()',
        /evaluate\("uses it"\) on fake: plugin "fetcher" has a build, which runs in a Docker image layer: use docker\(\)/,
      ],
      [
        'same-name',
        "plugin.local('../plugins/fetcher'), plugin.local('../plugins/fetcher-copy')",
        {
          'plugins/fetcher-copy/.claude-plugin/plugin.json': '{ "name": "fetcher" }',
          'plugins/fetcher-copy/agents/a.md': 'A.\n',
        },
        undefined,
        /evaluate\("uses it"\) on fake: environment env lists two plugins named "fetcher", plugin\.local\('plugins\/fetcher'\) and plugin\.local\('plugins\/fetcher-copy'\): rename one, or leave one out/,
      ],
      [
        'npx',
        "plugin.local('../plugins/fetcher')",
        {},
        ", egress: 'deny-all'",
        /the fetcher plugin's MCP server "search" runs npx, which fetches from registry\.npmjs\.org at start: add a build that installs it, or allow the host in egress/,
      ],
    ] as const) {
      const p = await project(`plugin-plan-${label}`, {
        'reeval.config.ts': config,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('env', ({ plugin }) => ({ plugins: [${call}] }))
evaluate('uses it', { environment: env${options ?? ''} }, async () => {})
`,
        'plugins/fetcher/.claude-plugin/plugin.json': JSON.stringify({
          name: 'fetcher',
          mcpServers: { search: { command: 'npx', args: ['-y', '@acme/search-mcp@1.0.0'] } },
        }),
        ...files,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${label}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, refusal, label)
    }
  })

  test('the text plan names each restricted policy and its automatic hosts', async () => {
    const p = await fixture('plan/egress')
    const r = await runCli(p.dir, ['run', '--dry-run', 'evals/auto.eval.ts'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /egress: deny-all \+ auto: generativelanguage\.googleapis\.com, mcp\.example\.com, events\.example\.com$/m,
    )
    assert.match(r.stdout, /egress: allow api\.example\.com \+ auto: uploads\.example\.com/)
  })

  test("a cell filter narrows each row's counts in the text plan, not only the totals", async () => {
    const p = await fixture('plan/compare')
    const r = await runCli(p.dir, ['run', '--dry-run', 'evals/variants.eval.ts', 'b/skilled'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /2 evals · 2 cells · 3 attempts/)
    const rows = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('evals/variants.eval.ts'))
      .map((l) => l.split(/\s{2,}/).slice(1, 5))
    assert.deepEqual(rows, [
      ['1', '1 of 2', '1', '1'],
      ['1', '1', '2', '2'],
    ])
  })

  test('a filter part that matches no file, eval name or cell exits 2 and names it', async () => {
    const p = await fixture('plan/compare')
    for (const args of [
      ['evals/variants.eval.ts', 'nosuchcell'],
      ['b/skilled', 'nosuchcell'],
    ]) {
      const r = await runCli(p.dir, ['run', '--dry-run', ...args])
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.equal(r.stdout, '')
      assert.match(
        r.stderr,
        /filter "nosuchcell" matches no eval file, eval name or cell in evals\/\*\*\/\*\.eval\.ts/,
      )
    }
  })

  test('--json without --dry-run runs, and prints the suite result instead of the plan', async () => {
    const p = await project('plan-run-json', {
      'reeval.config.ts': fakeConfig(),
      'evals/hello.eval.ts': `import { evaluate } from 'reeval'
evaluate('runs', async (c) => { await c.send('hi') })
`,
    })
    const r = await runCli(p.dir, ['run', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const doc = JSON.parse(r.stdout)
    assert.equal(typeof doc.runId, 'string', r.stderr)
    assert.ok(Array.isArray(doc.files) && Array.isArray(doc.paths), 'a SuiteResult')
    assert.equal(doc.totals, undefined, 'not the plan document')
  })
})

/** The root warning `reeval run` prints for the privileges fixture's eval-level sandbox. */
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
        file: 'evals/p.eval.ts',
        message:
          'running as root in the sandbox: group("system packages") (docker({ root: true }))',
      },
      {
        kind: 'root',
        level: 'eval',
        where: 'evaluate("installs deps")',
        file: 'evals/p.eval.ts',
        message:
          'running as root in the sandbox: evaluate("installs deps") (docker({ root: true }))',
      },
      {
        kind: 'capabilities',
        level: 'config',
        where: 'reeval.config.ts',
        file: null,
        capabilities: ['NET_RAW'],
        message:
          "extra capabilities in the sandbox: reeval.config.ts (docker({ capabilities: ['NET_RAW'] }))",
      },
      {
        kind: 'capabilities',
        level: 'eval',
        where: 'evaluate("installs deps")',
        file: 'evals/p.eval.ts',
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
      /^warning: extra capabilities in the sandbox: reeval\.config\.ts \(docker\(\{ capabilities: \['NET_RAW'\] \}\)\)$/m,
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
      /^::warning file=evals\/p\.eval\.ts,title=Sandbox runs as root::running as root in the sandbox: evaluate\("installs deps"\) \(docker\(\{ root: true \}\)\)$/m,
    )
    assert.match(
      gh.stdout,
      /^::warning title=Sandbox has extra capabilities::extra capabilities in the sandbox: reeval\.config\.ts/m,
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
