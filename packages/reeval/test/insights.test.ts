// Run insights: the validator's canaries (each a sentence a model could write that must not
// print), the layouts insights fill, staleness, and `reeval analyze --insights` end to end on a
// corpus run with the fake analysis model.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { insights as recipeInsights } from '../scripts/output/project/insights.ts'
import type { ResolvedAnalysisModel } from '../src/analysis/model.ts'
import type { RunRecord } from '../src/history/types.ts'
import { generateInsights, insightEvals } from '../src/insights/generate.ts'
import { canonicalJson, factsHash } from '../src/insights/hash.ts'
import type { FakeInsights, FakeInsightsInput } from '../src/types.ts'
import { colors } from '../src/ui/colors.ts'
import { evalBlock, render } from '../src/ui/layout.ts'
import type { RunInsights } from '../src/view/insights.ts'
import { readableInsights, readableRecord } from '../src/view/record.ts'
import { type EvalResult, suiteResult } from '../src/view/suite.ts'
import { runCli } from './helpers.ts'
import { corpusEntries, HISTORY_DIR } from './support/corpus.ts'
import { fixture } from './support/fixture.ts'

const entry = corpusEntries().find((e) => e.name === 'with-insights')
assert.ok(entry, 'the with-insights corpus entry')
const run = entry.runs.at(-1)
assert.ok(run)
const record = readableRecord(structuredClone(run.raw) as never) as RunRecord
const suite = suiteResult(record)
const runDir = join(run.file, '..', run.runId)

const evalNamed = (name: string): EvalResult => {
  const e = insightEvals(suite).find((x) => (x.template ?? x.name) === name)
  assert.ok(e, name)
  return e
}
const choose = evalNamed('recommends Genkit for $task')
const measure = evalNamed('greets in the house style')
const french = evalNamed('greets in French')

type Fake = (input: FakeInsightsInput) => FakeInsights

/** The recipe's fake insight model, with `change` applied to one eval's calls. */
const recipeWith =
  (path: string, change: (input: FakeInsightsInput, answer: FakeInsights) => FakeInsights): Fake =>
  (input) => {
    const answer = recipeInsights(input)
    return input.call !== 'headline' && input.eval.path === path ? change(input, answer) : answer
  }

const generate = (fake: Fake) => {
  const model: ResolvedAnalysisModel = {
    name: 'fake',
    route: 'fake',
    fake: { kind: 'fake-analysis', insights: fake },
  }
  return generateInsights({ record, runDir, model, maxOutputTokens: 1000, concurrency: 2 })
}

const insightOf = (doc: RunInsights, e: EvalResult) => {
  const x = doc.evals.find((i) => i.evalId === e.path)
  assert.ok(x, e.path)
  return x
}

const BANNED = 'with-skill helped, well beyond the noise.'

describe('the insights validator', () => {
  test('the recipe insights pass every check, as the with-insights entry holds them', async () => {
    const doc = await generate(recipeInsights)
    assert.deepEqual(doc.validation, { dropped: 0, regenerated: 0 })
    const stored = readableInsights(JSON.parse(readFileSync(join(runDir, 'insights.json'), 'utf8')))
    assert.deepEqual(
      { ...doc, createdAt: '' },
      { ...stored, createdAt: '' },
      're-record with-insights if the recipe changed',
    )
  })

  test('canary: an uncited answer is dropped', async () => {
    const doc = await generate(
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights' && a.answer ? { ...a, answer: { ...a.answer, cites: [] } } : a,
      ),
    )
    assert.equal(insightOf(doc, measure).answer, null)
    assert.equal(doc.validation.dropped, 1)
  })

  test('canary: a sentence citing a fact it was never shown is dropped', async () => {
    const doc = await generate(
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights' && a.answer
          ? { ...a, answer: { ...a.answer, cites: [`${measure.path}/checks/no such check`] } }
          : a,
      ),
    )
    assert.equal(insightOf(doc, measure).answer, null)
    assert.equal(doc.validation.dropped, 1)
  })

  test('canary: a banned word is asked for once more, then dropped', async () => {
    const withSkill = (measure.cells ?? []).find((c) => c.effect === 'better')
    assert.ok(withSkill)
    const banned = (fixed: boolean): Fake =>
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              rows: (a.rows ?? []).map((r) =>
                r.row === withSkill.path && !(fixed && input.retry) ? { ...r, text: BANNED } : r,
              ),
            }
          : a,
      )
    const twice = await generate(banned(false))
    assert.deepEqual(twice.validation, { dropped: 1, regenerated: 1 })
    assert.ok(!insightOf(twice, measure).rows?.some((r) => r.row === withSkill.path))
    const fixed = await generate(banned(true))
    assert.deepEqual(fixed.validation, { dropped: 0, regenerated: 1 })
    assert.ok(insightOf(fixed, measure).rows?.some((r) => r.row === withSkill.path))
  })

  test('canary: a sentence on a row the layout keeps closed, a passing case, is dropped', async () => {
    const passing = (choose.cases ?? []).find((k) => k.outcome === 'pass')
    assert.ok(passing)
    const doc = await generate(
      recipeWith(choose.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              rows: [
                ...(a.rows ?? []),
                { row: passing.path, text: 'It names Genkit.', cites: [passing.path] },
              ],
            }
          : a,
      ),
    )
    assert.ok(!insightOf(doc, choose).rows?.some((r) => r.row === passing.path))
    assert.equal(doc.validation.dropped, 1)
  })

  test('canary: a named tool the final message never names is dropped', async () => {
    const doc = await generate(
      recipeWith(choose.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              namedTools: input.attempts.map((x) => ({
                attempt: x.id,
                tools: ['Genkit', 'Mastra'],
              })),
            }
          : a,
      ),
    )
    const named = insightOf(doc, choose).namedTools ?? []
    assert.equal(named.length, 6)
    for (const n of named) assert.deepEqual(n.tools, ['Genkit'])
    assert.equal(doc.validation.dropped, 6)
  })

  test('a sentence over 25 words is dropped, and an effect word must be the cited effect', async () => {
    const plain = (measure.cells ?? []).find((c) => c.baseline)
    assert.ok(plain)
    const doc = await generate(
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              answer: {
                text: `No: ${'very '.repeat(30)}close.`,
                cites: [measure.path],
              },
              rows: [{ row: plain.path, text: 'plain helped.', cites: [plain.path] }],
            }
          : a,
      ),
    )
    const x = insightOf(doc, measure)
    assert.equal(x.answer, null)
    assert.equal(x.rows, undefined)
    assert.equal(doc.validation.dropped, 2)
  })
})

describe('insights in the layouts', () => {
  test('canary: job choose on a finish-shaped eval prints the choose layout', async () => {
    const doc = await generate(
      recipeWith(french.path, (input, a) =>
        input.call === 'classify'
          ? {
              intent: {
                job: 'choose',
                question: 'Does it pick Genkit?',
                subject: { tool: 'Genkit' },
              },
            }
          : a,
      ),
    )
    const c = colors(false)
    const without = evalBlock(c, french, false, null)
    const block = evalBlock(c, french, false, insightOf(doc, french))
    assert.ok(!without.some((l) => /^ {2}Genkit +0 of 1$/.test(l)))
    assert.ok(
      block.some((l) => /^ {2}Genkit +0 of 1$/.test(l)),
      `the subject's count:\n${block.join('\n')}`,
    )
  })

  test('insights written for other facts are left out, with a note', () => {
    const stored = readableInsights(JSON.parse(readFileSync(join(runDir, 'insights.json'), 'utf8')))
    const opts = { color: false, verbose: false, hint: false }
    const fresh = render(suite, stored, opts).join('\n')
    const plain = render(suite, null, opts).join('\n')
    const stale = render(suite, { ...stored, factsHash: 'sha256:other' }, opts).join('\n')
    assert.ok(stored.headline && fresh.includes(stored.headline.text))
    assert.ok(!stale.includes(stored.headline.text))
    assert.match(stale, /insights left out: insights\.json was written for other facts/)
    assert.equal(stale.replace(/\n.*insights left out.*/, ''), plain)
  })

  test('factsHash is the canonical JSON of the facts, so key order never changes it', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}')
    const reordered = Object.fromEntries(Object.entries(suite).reverse()) as typeof suite
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(suite))
    assert.equal(factsHash(reordered), factsHash(suite))
    assert.match(factsHash(suite), /^sha256:[0-9a-f]{64}$/)
  })

  test('insights from a newer reeval are refused by name', () => {
    const stored = JSON.parse(readFileSync(join(runDir, 'insights.json'), 'utf8'))
    assert.throws(
      () => readableInsights({ ...stored, schemaVersion: 2 }, 'insights.json'),
      /insights\.json .*written by a newer reeval/,
    )
  })
})

const FAKE_CONFIG = `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { insights } from './insights.ts'

export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: { model: fakeAnalysis({ insights }) },
})
`

describe('reeval analyze --insights', () => {
  test('writes a recorded run insights.json once, reeval show prints them, and exits 0', async () => {
    const p = await fixture('fixtures/records/before-insights')
    writeFileSync(join(p.dir, 'reeval.config.ts'), FAKE_CONFIG)
    writeFileSync(
      join(p.dir, 'insights.ts'),
      readFileSync(new URL('../scripts/output/project/insights.ts', import.meta.url), 'utf8'),
    )
    const [runId] =
      corpusEntries()
        .find((e) => e.name === 'before-insights')
        ?.runs.map((r) => r.runId) ?? []
    assert.ok(runId)
    const file = join(p.dir, HISTORY_DIR, runId, 'insights.json')

    const before = await runCli(p.dir, ['show', runId])
    assert.equal(before.code, 0, before.stderr)
    assert.ok(!before.stdout.includes('Not for a Python agent'))

    const first = await runCli(p.dir, ['analyze', runId, '--insights'])
    assert.equal(first.code, 0, first.stdout + first.stderr)
    assert.match(
      first.stderr,
      /wrote .*insights\.json: 13 evals, 0 sentences removed by the checks/,
    )
    assert.match(first.stdout, /Not for a Python agent: 0 of 2 tries passed\./)
    const doc = readableInsights(JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(doc.runId, runId)
    assert.equal(doc.model, 'fake')

    const shown = await runCli(p.dir, ['show', runId])
    assert.equal(shown.code, 0, shown.stderr)
    assert.match(shown.stdout, /Not for a Python agent: 0 of 2 tries passed\./)
    assert.ok(doc.headline && shown.stdout.includes(doc.headline.text))

    const again = await runCli(p.dir, ['analyze', runId, '--insights'])
    assert.notEqual(again.code, 0)
    assert.match(again.stderr, /already exists, and insights are never rewritten/)
    assert.deepEqual(readableInsights(JSON.parse(readFileSync(file, 'utf8'))), doc)

    const flags = await runCli(p.dir, ['analyze', runId, '--insights', '--save'])
    assert.equal(flags.code, 2)
    assert.match(flags.stderr, /takes a run and --json only, not --save/)

    const scratch = await runCli(p.dir, ['run', 'greets in French'])
    assert.ok(scratch.code === 0 || scratch.code === 1, scratch.stderr)
    const refused = await runCli(p.dir, ['analyze', 'latest', '--insights'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /isn't recorded, so there's no history folder for its insights/)
    assert.ok(existsSync(file))
  })

  test('a model that fails writes nothing, so it can be asked again', async () => {
    const p = await fixture('fixtures/records/before-insights')
    writeFileSync(
      join(p.dir, 'reeval.config.ts'),
      FAKE_CONFIG.replace("import { insights } from './insights.ts'\n", '').replace(
        'fakeAnalysis({ insights })',
        "fakeAnalysis({ insights: { error: 'quota exceeded' } })",
      ),
    )
    const r = await runCli(p.dir, ['analyze', '--insights'])
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /quota exceeded/)
    const [runId] =
      corpusEntries()
        .find((e) => e.name === 'before-insights')
        ?.runs.map((x) => x.runId) ?? []
    assert.ok(!existsSync(join(p.dir, HISTORY_DIR, runId as string, 'insights.json')))
  })
})
