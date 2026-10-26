// reeval's own model calls through openrouter() on real OpenRouter (contract.yml, when a dispatch
// names an *-openrouter row): the decision-model judge and the analysis model, on the fake harness
// so no agent spends anything. Checks what OpenRouter says about each call (the served model, the
// upstream provider and the cost), never the model's wording, and never retries. Skipped unless
// REEVAL_TEST_REAL=1; asked for, it fails naming OPENROUTER_API_KEY when that isn't set.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { validate } from '../scripts/schema/validate.ts'
import { OPENROUTER_JUDGE_MODEL } from '../src/judge/index.ts'
import type { AnalysisDoc } from '../src/view/analysis.ts'
import { pkgRoot, project, readRun, runCli } from './helpers.ts'

const ANALYSIS_MODEL = 'google/gemini-3.8-flash'

test('openrouter(): the Jev judge and the analysis model record what OpenRouter served and charged', {
  skip:
    process.env.REEVAL_TEST_REAL === '1' ? false : 'set REEVAL_TEST_REAL=1 to call a real model',
  timeout: 300_000,
}, async (t) => {
  const key = process.env.OPENROUTER_API_KEY
  assert.ok(
    key,
    "OPENROUTER_API_KEY isn't set, and REEVAL_TEST_REAL=1 asks for real OpenRouter calls",
  )
  const p = await project('openrouter-real', {
    'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { openrouter } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: fakeHarness({ files: { 'greet.js': 'export const greet = (name) => \`Hello, \${name}!\`\\n' } }),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  gateway: [openrouter()],
  judge: { model: '${OPENROUTER_JUDGE_MODEL}' },
  analysis: { model: '${ANALYSIS_MODEL}' },
  runs: 1,
  budget: { attempts: 1 },
})
`,
    'evals/greet.eval.ts': `import { evaluate } from 'reeval'
evaluate('writes a greet(name) function', async (c) => {
  await c.send('Create greet.js exporting greet(name), which returns "Hello, <name>!".')
  await c.judge('Does the workspace have a greet.js that greets by name?')
})
`,
  })
  const r = await runCli(p.dir, ['run'], {
    env: { OPENROUTER_API_KEY: key },
    timeoutMs: 240_000,
  })
  assert.ok(r.code === 0 || r.code === 1, `reeval run exited ${r.code}\n${r.stdout}\n${r.stderr}`)
  const { run } = readRun(p.dir)
  const schema = JSON.parse(
    readFileSync(join(pkgRoot, 'schema/run-record.schema.json'), 'utf8'),
  ) as ShapeSchema
  assert.deepEqual(validate(schema, run), [], 'the record fits its schema')

  const judgement = run.evals[0]?.attempts[0]?.judgements?.[0]
  assert.ok(judgement, `no judgement recorded\n${r.stdout}\n${r.stderr}`)
  t.diagnostic(
    `${judgement.resolvedModel} on ${judgement.upstream} · $${judgement.costUsd} · score ${judgement.score}`,
  )
  assert.equal(judgement.model, OPENROUTER_JUDGE_MODEL)
  assert.equal(judgement.gateway, 'openrouter')
  assert.ok(judgement.resolvedModel, 'OpenRouter names the model that served the judge')
  assert.ok(judgement.upstream, 'OpenRouter names the upstream provider that served the judge')
  assert.ok(
    typeof judgement.costUsd === 'number' && judgement.costUsd >= 0,
    `the judge's cost: ${judgement.costUsd}`,
  )
  assert.match(r.stdout, /judge served by \S/, "the output names the judge's upstream")

  const analyze = await runCli(p.dir, ['analyze', run.runId, '--json'], {
    env: { OPENROUTER_API_KEY: key },
    timeoutMs: 120_000,
  })
  assert.equal(analyze.code, 0, `reeval analyze\n${analyze.stdout}\n${analyze.stderr}`)
  const doc = JSON.parse(analyze.stdout) as AnalysisDoc
  assert.equal(doc.model, ANALYSIS_MODEL)
  assert.equal(doc.route, 'openrouter')
  assert.ok(
    (doc.usage.inputTokens ?? 0) > 0 && (doc.usage.outputTokens ?? 0) > 0,
    'the analysis call ran',
  )
})
