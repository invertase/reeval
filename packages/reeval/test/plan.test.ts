// Tier P: "given this config and these evals, the matrix is Y". Each case runs
// `reeval run --dry-run --json` on a directory under test/plan/ and compares the normalised matrix
// with test/plan/<dir>/expected/<case>.txt. REEVAL_UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { describe, test } from 'node:test'
import { fakeConfig, project, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import { matchFile, type PlanCase, planJson, renderPlan } from './support/plan.ts'
import { syncPythonFixtureProject } from './support/python-fixture.ts'

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
    args: [],
    prepare: (dir) => syncPythonFixtureProject(dir),
  },
  { dir: 'selection', name: 'only-local', args: [] },
  { dir: 'selection', name: 'tags', args: ['--tag', 'slow', '--tag', '!flaky'] },
  { dir: 'selection', name: 'group-and-eval-filter', args: ['slow things › big'] },
  { dir: 'images', name: 'install-from-dockerfile', args: [] },
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
  { dir: 'egress', name: 'cascade', args: [] },
  {
    dir: 'egress',
    name: 'profile-defaults',
    args: ['--profile', 'locked', 'evals/cascade.eval.ts'],
  },
  { dir: 'privileges', name: 'levels', args: [] },
  { dir: 'privileges', name: 'profile', args: ['--profile', 'rooted'] },
  { dir: 'workspace', name: 'git', args: [] },
  { dir: 'files', name: 'directory', args: [] },
  { dir: 'plugins', name: 'parts', args: ['evals/parts.eval.ts'] },
  { dir: 'plugins', name: 'remote', args: ['evals/remote.eval.ts'] },
  { dir: 'plugins', name: 'fetches-at-start', args: ['evals/fetches.eval.ts'] },
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
      matchFile(`plan/${c.dir}/expected/${c.name}.txt`, renderPlan(await planJson(c)))
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
      'warnings',
      'sandboxWarnings',
      'hints',
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

  test("OpenCode on a provider reeval can't broker exits 2 at plan time, naming it and why", async () => {
    for (const [where, model, refusal, env] of [
      [
        'config',
        'google-vertex/gemini-3.8-flash',
        /opencode\(\): reeval can't run OpenCode on Vertex \(google-vertex\): it takes a service account \(Vertex refuses API keys for most models\), not a key in a header, so the gateway can't keep its key out of the sandbox/,
      ],
      [
        'config',
        'amazon-bedrock/global.anthropic.claude-haiku-4-5',
        /opencode\(\): AWS_REGION is "evil\.example\.com\/x", which isn't one Amazon Bedrock \(amazon-bedrock\) takes: OpenCode builds its API's host from it, so it must match/,
        { AWS_REGION: 'evil.example.com/x' },
      ],
      [
        'eval',
        'lmstudio/qwen3-coder',
        /opencode\(\): reeval can't run OpenCode on LMStudio \(lmstudio\): it runs on your machine, and the sandbox can't reach the host's localhost/,
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

  test('every real harness refuses a plugin at plan time, naming the eval, the harness and the plugin', async () => {
    const plugin = {
      'plugins/review/.claude-plugin/plugin.json': '{ "name": "review" }',
      'plugins/review/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints.\n---\n\nLint.\n',
    }
    for (const [factory, model, name] of [
      ['cursor', 'composer-2.5', 'Cursor'],
      ['claudeCode', 'claude-sonnet-5', 'Claude Code'],
      ['antigravity', 'gemini-3.8-flash-low', 'Antigravity'],
      ['opencode', 'google/gemini-3.8-flash', 'OpenCode'],
      ['goose', 'gemini-3.8-flash', 'Goose'],
      ['pi', 'gemini-3.8-flash', 'pi'],
      ['codex', 'gpt-5.4-mini', 'Codex'],
      ['fx', 'gpt-4.1-mini', 'fx'],
      ['grokBuild', 'grok-4.6', 'Grok Build'],
    ] as const) {
      const p = await project(`plugin-refused-${factory}`, {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
export default defineConfig({ harness: ${factory}({ model: '${model}' }) })
`,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const review = defineEnvironment('review', ({ plugin }) => ({ plugins: [plugin.local('../plugins/review')] }))
evaluate('reviews', { environment: review }, async () => {})
`,
        ...plugin,
      })
      const r = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(r.code, 2, `${factory}: ${r.stdout}${r.stderr}`)
      assert.equal(r.stdout, '', factory)
      assert.match(
        r.stderr,
        new RegExp(
          `evaluate\\("reviews"\\) on ${factory === 'claudeCode' ? 'claude-code' : factory === 'grokBuild' ? 'grok-build' : factory}:[^:]+: ${name} can't load plugins yet: leave the review plugin out of this cell`,
        ),
      )
      assert.deepEqual(readdirSync(p.dir).includes('.reeval'), false, 'nothing ran')
    }
  })

  test('a plugin the plan reads and refuses exits 2: no manifest, a build, npx under deny-all', async () => {
    const config = `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: fakeHarness(), sandbox: docker({ from: 'node:22-bookworm' }) })
`
    for (const [label, call, files, egress, refusal] of [
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
        undefined,
        /plugin\.local\('plugins\/fetcher'\) has a build, which reeval doesn't run yet: leave build out, and install what the plugin needs in the image with docker\(\{ install \}\)/,
      ],
      [
        'npx',
        "plugin.local('../plugins/fetcher')",
        {},
        'deny-all',
        /the fetcher plugin's MCP server "search" runs npx, which fetches from registry\.npmjs\.org at start: install it in the image \(docker\(\{ install \}\)\), or allow the host in egress/,
      ],
    ] as const) {
      const p = await project(`plugin-plan-${label}`, {
        'reeval.config.ts': config,
        'evals/p.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const env = defineEnvironment('env', ({ plugin }) => ({ plugins: [${call}] }))
evaluate('uses it', { environment: env${egress ? `, egress: '${egress}'` : ''} }, async () => {})
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
