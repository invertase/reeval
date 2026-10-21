// Run insights: the validator's canaries (each a sentence a model could write that must not
// print), the layouts insights fill, staleness, `reeval analyze --insights` end to end on a corpus
// run, and `reeval run` writing them at its end (the budget, its order, the per-eval caps, the call
// timeout, Ctrl-C, the cache), all with the fake analysis model.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { insights as recipeInsights } from '../scripts/output/project/insights.ts'
import type { ResolvedAnalysisModel } from '../src/analysis/model.ts'
import type { RunRecord } from '../src/history/types.ts'
import { admit, estimate, FIRST_ESTIMATE, ledger, reserve, settle } from '../src/insights/budget.ts'
import {
  generateInsights,
  INSIGHT_OUTPUT_TOKENS,
  type InsightOptions,
  insightEvals,
} from '../src/insights/generate.ts'
import { canonicalJson, factsHash } from '../src/insights/hash.ts'
import {
  attemptTexts,
  evalFacts,
  type InsightFact,
  type InsightInput,
} from '../src/insights/input.ts'
import { byPriority, insightTier } from '../src/insights/priority.ts'
import { insightsPromptVersion } from '../src/insights/schema.ts'
import { trimInput } from '../src/insights/trim.ts'
import { type Citable, checkSentence } from '../src/insights/validate.ts'
import type { FakeInsights, FakeInsightsInput } from '../src/types.ts'
import { colors } from '../src/ui/colors.ts'
import { evalBlock, render, slotsOf } from '../src/ui/layout.ts'
import type { RunInsights } from '../src/view/insights.ts'
import { readableInsights, readableRecord } from '../src/view/record.ts'
import { type EvalResult, suiteResult } from '../src/view/suite.ts'
import { noSignals, project, readRun, runCli } from './helpers.ts'
import { corpusEntries, HISTORY_DIR } from './support/corpus.ts'
import { fixture } from './support/fixture.ts'

const entry = corpusEntries().find((e) => e.name === 'with-insights')
assert.ok(entry, 'the with-insights corpus entry')
const run = entry.runs.at(-1)
assert.ok(run)
const record = readableRecord(structuredClone(run.raw) as never) as RunRecord
const suite = suiteResult(record)
const runDir = join(run.file, '..', run.runId)
/**
 * The entry's insights.json, held to these facts: it keeps the hash of the facts the reeval that
 * recorded it computed, which a later change to `SuiteResult` moves.
 */
const storedFresh = () => ({
  ...readableInsights(JSON.parse(readFileSync(join(runDir, 'insights.json'), 'utf8'))),
  factsHash: factsHash(suite),
})

const evalNamed = (name: string): EvalResult => {
  const e = insightEvals(suite).find((x) => (x.template ?? x.name) === name)
  assert.ok(e, name)
  return e
}
const choose = evalNamed('recommends Genkit for $task')
const measure = evalNamed('greets in the house style')
const french = evalNamed('greets in French')
const once = evalNamed('greets once')

type Fake = (input: FakeInsightsInput) => FakeInsights

/** The recipe's fake insight model, with `change` applied to one eval's calls. */
const recipeWith =
  (path: string, change: (input: FakeInsightsInput, answer: FakeInsights) => FakeInsights): Fake =>
  (input) => {
    const answer = recipeInsights(input)
    return input.call !== 'headline' && input.eval.path === path ? change(input, answer) : answer
  }

const generate = (
  fake: (input: FakeInsightsInput) => FakeInsights | Promise<FakeInsights>,
  options: Pick<
    InsightOptions,
    'callTimeoutMs' | 'maxInputChars' | 'maxTokens' | 'concurrency' | 'signal'
  > = {},
) => {
  const model: ResolvedAnalysisModel = {
    name: 'fake',
    route: 'fake',
    fake: { kind: 'fake-analysis', insights: fake },
  }
  return generateInsights({ record, runDir, model, concurrency: 2, ...options })
}

const insightOf = (doc: RunInsights, e: EvalResult) => {
  const x = doc.evals.find((i) => i.evalId === e.path)
  assert.ok(x, e.path)
  return x
}

const BANNED = 'with-skill helped, well beyond the noise.'

/** The short id the model is shown for a fact's path. */
const idOf = (input: FakeInsightsInput, path: string) => {
  const id = input.call === 'headline' ? undefined : input.facts.find((f) => f.path === path)?.id
  assert.ok(id, path)
  return id
}

/** An insight's sentences: what the recipe's fake writes, whatever the prompt version. */
const sentencesOf = (doc: RunInsights) => ({
  headline: doc.headline,
  evals: doc.evals.map(({ evalId, answer, findings, rows, namedTools, intent }) => ({
    evalId,
    job: intent.job,
    answer,
    findings,
    rows,
    namedTools,
  })),
})

describe('the insights validator', () => {
  test('the recipe insights pass every check, as the with-insights entry holds them', async () => {
    const doc = await generate(recipeInsights)
    assert.deepEqual(doc.validation, { dropped: 0, regenerated: 0, drops: [] })
    assert.equal(doc.promptVersion, insightsPromptVersion())
    const stored = readableInsights(JSON.parse(readFileSync(join(runDir, 'insights.json'), 'utf8')))
    assert.deepEqual(
      sentencesOf(doc),
      sentencesOf(stored),
      'add a corpus entry if the recipe changed',
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
    assert.deepEqual(
      doc.validation.drops?.map((d) => [d.slot, d.reason]),
      [['greets in the house style › answer', 'cites nothing']],
    )
  })

  test('canary: a cite to an id the model was never shown is dropped', async () => {
    const doc = await generate(
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights' && a.answer
          ? { ...a, answer: { ...a.answer, cites: ['F999'] } }
          : a,
      ),
    )
    assert.equal(insightOf(doc, measure).answer, null)
    assert.deepEqual(
      doc.validation.drops?.map((d) => d.reason),
      ["cites F999, which isn't a fact it was shown"],
    )
  })

  test('the model cites short ids, and insights.json keeps the fact paths', async () => {
    let shown: FakeInsightsInput | undefined
    const doc = await generate(
      recipeWith(choose.path, (input, a) => {
        if (input.call === 'insights') shown = input
        return a
      }),
    )
    assert.ok(shown && shown.call === 'insights')
    assert.deepEqual(
      shown.facts.map((f) => f.id),
      shown.facts.map((_, i) => `F${i + 1}`),
    )
    assert.ok(shown.slots?.rows.every((r) => /^F\d+$/.test(r)))
    assert.ok(shown.attempts.every((x, i) => x.id === `A${i + 1}` && /^F\d+$/.test(x.cell)))
    const x = insightOf(doc, choose)
    const paths = new Set(shown.facts.map((f) => f.path))
    for (const s of [x.answer, ...(x.rows ?? [])])
      for (const c of s?.cites ?? []) assert.ok(paths.has(c), c)
    for (const r of x.rows ?? []) assert.ok(paths.has(r.row), r.row)
    for (const n of x.namedTools ?? []) assert.match(n.attempt, /#\d+$/)
  })

  test('canary: ids never reach the text: a trailing id list is cut, an id inside is dropped', async () => {
    const answerText = (text: string): Fake =>
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights' && a.answer ? { ...a, answer: { ...a.answer, text } } : a,
      )
    const trailing = await generate(answerText('Yes: every try passed (F1, F2 and A1#L3).'))
    assert.equal(insightOf(trailing, measure).answer?.text, 'Yes: every try passed.')
    assert.equal(trailing.validation.dropped, 0)
    const inside = await generate(answerText('F1 says every try passed.'))
    assert.equal(insightOf(inside, measure).answer, null)
    assert.equal(inside.validation.regenerated, 1)
    assert.deepEqual(
      inside.validation.drops?.map((d) => d.reason),
      ['names F1 in its text; ids go in cites only'],
    )
  })

  test('canary: a headline calling the tally a count of evals is dropped', async () => {
    const total = Object.values(suite.tally).reduce((a, b) => a + b, 0)
    const evals = insightEvals(suite).length
    assert.notEqual(total, evals, 'the recipe has families, so results outnumber evals')
    const headline =
      (text: string): Fake =>
      (input) =>
        input.call === 'headline'
          ? { headline: { text, cites: [input.evals[0]?.id ?? ''] } }
          : recipeInsights(input)
    const wrong = await generate(headline(`Nine of ${total} evals fail.`))
    assert.equal(wrong.headline, null)
    assert.deepEqual(
      wrong.validation.drops?.map((d) => [d.slot, d.reason]),
      [
        [
          'headline',
          `says ${total} evals, but the run has ${evals}; the tally counts results, not evals`,
        ],
      ],
    )
    const right = await generate(headline(`9 of ${total} results fail.`))
    assert.equal(right.headline?.text, `9 of ${total} results fail.`)
  })

  test('canary: a finding that repeats a row sentence is dropped', async () => {
    const doc = await generate(
      recipeWith(measure.path, (input, a) => {
        const row = a.rows?.[0]
        return input.call === 'insights' && row
          ? {
              ...a,
              findings: [...(a.findings ?? []), { ...row, text: ` ${row.text.toUpperCase()}` }],
            }
          : a
      }),
    )
    const x = insightOf(doc, measure)
    const shown = x.rows?.[0]?.text.toLowerCase()
    assert.ok(shown)
    assert.ok(!x.findings.some((f) => f.text.trim().toLowerCase() === shown))
    assert.deepEqual(
      doc.validation.drops?.map((d) => d.reason),
      ['repeats a sentence already shown'],
    )
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
                r.row === idOf(input, withSkill.path) && !(fixed && input.retry)
                  ? { ...r, text: BANNED }
                  : r,
              ),
            }
          : a,
      )
    const twice = await generate(banned(false))
    assert.equal(twice.validation.dropped, 1)
    assert.equal(twice.validation.regenerated, 1)
    assert.deepEqual(
      twice.validation.drops?.map((d) => [d.text, d.reason]),
      [[BANNED, 'says "noise"; use plain words']],
    )
    assert.ok(!insightOf(twice, measure).rows?.some((r) => r.row === withSkill.path))
    const fixed = await generate(banned(true))
    assert.deepEqual(fixed.validation, { dropped: 0, regenerated: 1, drops: [] })
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
                {
                  row: idOf(input, passing.path),
                  text: 'It names Genkit.',
                  cites: [idOf(input, passing.path)],
                },
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
                tools: ['Genkit', 'Mastra', 'Gen'],
              })),
            }
          : a,
      ),
    )
    const named = insightOf(doc, choose).namedTools ?? []
    assert.equal(named.length, 6)
    for (const n of named) assert.deepEqual(n.tools, ['Genkit'])
    assert.equal(doc.validation.dropped, 12, 'Mastra, and Gen, which is only part of a word')
  })

  /** The choose eval with no try naming Genkit, so its count is 0 where the case passed 2 of 2. */
  const withoutGenkit = (answer: string) =>
    generate(
      recipeWith(choose.path, (input, a) => {
        if (input.call !== 'insights') return a
        const chat = (choose.cases ?? []).find((k) => k.label === 'a chat app')
        assert.ok(chat)
        return {
          ...a,
          answer: { text: answer, cites: [idOf(input, chat.path)] },
          namedTools: (a.namedTools ?? []).map((n) => ({
            ...n,
            tools: n.tools.filter((t) => t !== 'Genkit'),
          })),
        }
      }),
    )

  test('canary: a count beside a named tool is that tool count, not the cited pass count', async () => {
    const doc = await withoutGenkit('The agent recommended Genkit in 2 of 2 tries.')
    assert.equal(insightOf(doc, choose).answer, null)
    assert.deepEqual(
      doc.validation.drops.map((d) => d.reason),
      ['has 2 of 2, which no cited fact has'],
    )
  })

  test("a named tool's own count is kept, and a pass count after the tool's outcome verb", async () => {
    for (const text of [
      'The agent recommended Genkit in 0 of 2 tries.',
      'The agent recommended LangChain in 2 of 2 tries.',
      'Recommending Genkit passed 2 of 2 tries.',
    ]) {
      const doc = await withoutGenkit(text)
      assert.equal(insightOf(doc, choose).answer?.text, text)
      assert.deepEqual(doc.validation.drops, [], text)
    }
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
                cites: [idOf(input, measure.path)],
              },
              rows: [
                {
                  row: idOf(input, plain.path),
                  text: 'plain helped.',
                  cites: [idOf(input, plain.path)],
                },
              ],
            }
          : a,
      ),
    )
    const x = insightOf(doc, measure)
    assert.equal(x.answer, null)
    assert.equal(x.rows, undefined)
    assert.equal(doc.validation.dropped, 2)
  })

  const unclearAnswer = (text: string) => {
    const withSkill = (once.cells ?? []).find((c) => c.effect === 'unclear')
    const plain = (once.cells ?? []).find((c) => c.baseline)
    assert.ok(withSkill && plain)
    return generate(
      recipeWith(once.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              answer: { text, cites: [idOf(input, withSkill.path), idOf(input, plain.path)] },
            }
          : a,
      ),
    )
  }

  test('an effect word under "can\'t tell yet if" isn\'t a claim, so the sentence is kept', async () => {
    const text =
      "The agent can with-skill, passing 1 of 1 tries, but we can't tell yet if it helped over plain's 0 of 1 tries."
    const doc = await unclearAnswer(text)
    assert.equal(insightOf(doc, once).answer?.text, text)
    assert.deepEqual(doc.validation, { dropped: 0, regenerated: 0, drops: [] })
  })

  test('canary: a bare "helped" against an unclear effect is dropped', async () => {
    const doc = await unclearAnswer('It helped, passing 1 of 1 tries.')
    assert.equal(insightOf(doc, once).answer, null)
    assert.deepEqual(
      doc.validation.drops?.map((d) => [d.slot, d.reason]),
      [['greets once › answer', 'says "helped", but no cited fact\'s effect is']],
    )
  })

  test('canary: an effect word after the hedged clause ends is a claim, and dropped', async () => {
    for (const text of [
      "We can't tell yet if it helped, and it made it worse.",
      "We can't tell yet if it helped and it made it worse.",
    ]) {
      const doc = await unclearAnswer(text)
      assert.equal(insightOf(doc, once).answer, null, text)
      assert.deepEqual(
        doc.validation.drops?.map((d) => d.reason),
        ['says "made it worse", but no cited fact\'s effect is'],
        text,
      )
    }
  })

  test('canary: a reply that is not the schema JSON is asked for once more, not fatal', async () => {
    const replies = new Map<string, number>()
    const once = (bad: number) =>
      generate((input) => {
        if (input.call !== 'insights') return recipeInsights(input)
        const n = (replies.get(input.eval.path) ?? 0) + 1
        replies.set(input.eval.path, n)
        return n <= bad ? ({ findings: 'not a list' } as never) : recipeInsights(input)
      })
    const doc = await once(1)
    assert.deepEqual(doc.validation, { dropped: 0, regenerated: 0, drops: [] })
    assert.ok(insightOf(doc, measure).answer)
    replies.clear()
    await assert.rejects(once(2), /No object generated/)
  })

  test('canary: a fourth finding is dropped, and the call that wrote it still counts', async () => {
    const doc = await generate(
      recipeWith(measure.path, (input, a) =>
        input.call === 'insights'
          ? {
              ...a,
              findings: ['one', 'two', 'three', 'four'].map((n) => ({
                text: `Plain passed writes greet.js in 4 of 4 tries, point ${n}.`,
                cites: [idOf(input, `${(measure.cells ?? [])[0]?.path}/checks/writes greet.js`)],
              })),
            }
          : a,
      ),
    )
    assert.equal(insightOf(doc, measure).findings.length, 3)
    assert.deepEqual(
      doc.validation.drops?.map((d) => [d.slot, d.reason]),
      [['greets in the house style › finding 4', 'is past the 3 findings an eval takes']],
    )
  })
})

describe('one sentence against what it cites', () => {
  const FACT = 'cell'
  const LINE = 'transcript:cell#1#L3'
  const facts: Record<string, { text: string; effect?: string }> = {
    [FACT]: { text: 'plain\n0 of 4 tries\nexit code 1', effect: 'no difference' },
    unclear: { text: 'with-skill\n1 of 1 tries', effect: "can't tell yet" },
    [LINE]: { text: 'L3 text: All 4 of 4 checks passed, exit code 2' },
  }
  const c: Citable = {
    resolve: (cite) => facts[cite]?.text ?? null,
    effects: (cite) => (facts[cite]?.effect ? [facts[cite].effect as string] : []),
    vocabulary: 'greets in the house style\nplain\nwith-skill',
    passCounts: true,
  }
  const verdict = (text: string, cites = [FACT]) => {
    const v = checkSentence({ text, cites }, c)
    return 'ok' in v ? 'kept' : 'dropped' in v ? v.dropped : v.banned
  }

  test('canary: a count must be the cited fact own count, even below 6', () => {
    assert.equal(verdict('Plain passed 0 of 4 tries.'), 'kept')
    assert.equal(verdict('Plain failed 4 of 4 tries.'), 'kept')
    assert.equal(verdict('Plain failed, with 0 of 4 tries passed.'), 'kept')
    assert.equal(
      verdict('Plain failed 0 of 4 tries.'),
      'has 0 of 4, which no cited fact has',
      'it failed all 4',
    )
    assert.equal(verdict('Plain passed 4 of 4 tries.'), 'has 4 of 4, which no cited fact has')
    assert.equal(verdict('Plain passed 3 of 4 tries.'), 'has 3 of 4, which no cited fact has')
    assert.equal(
      verdict('Plain passed four of four tries.'),
      'has four of four, which no cited fact has',
    )
    assert.equal(
      verdict('Plain passed 4 of 4 tries.', [FACT, LINE]),
      'has 4 of 4, which no cited fact has',
      "a transcript line's text isn't a count",
    )
  })

  test('canary: a small number no cited fact holds is dropped', () => {
    assert.equal(verdict('House greeting failed with exit code 1.'), 'kept')
    assert.equal(
      verdict('House greeting failed with exit code 2.'),
      'has 2, which no cited fact has',
    )
    assert.equal(verdict('It exited with code 2.', [FACT, LINE]), 'kept')
  })

  test('canary: an effect said in other words must be the cited effect', () => {
    for (const [text, word] of [
      ['The skill helps the agent.', 'helps'],
      ['The skill improved the greeting.', 'improved'],
      ['The skill made things worse.', 'made things worse'],
      ['The skill hurt the agent.', 'hurt'],
    ]) {
      assert.equal(verdict(text), `says "${word}", but no cited fact's effect is`, text)
    }
    assert.equal(verdict("The skill didn't help."), 'kept')
  })

  test('canary: a hedged clause ends at a comma, a dash or a conjunction', () => {
    const hedged = (text: string) => verdict(text, ['unclear'])
    assert.equal(hedged("We can't tell yet whether it helped or made it worse."), 'kept')
    for (const text of [
      "We can't tell yet if it helped – it made it worse.",
      "We can't tell yet if it helped while plain made it worse.",
      "We can't tell yet if it helped: it made it worse.",
    ]) {
      assert.equal(hedged(text), 'says "made it worse", but no cited fact\'s effect is', text)
    }
  })

  test('canary: a quote in single, curly or backtick quotes must be in what it cites', () => {
    for (const q of ["'exit code 1'", '‘exit code 1’', '`exit code 1`', '"exit code 1"']) {
      assert.equal(verdict(`It ended with ${q}.`), 'kept', q)
      const wrong = q.replace('1', '0').replace('code', 'status')
      assert.match(verdict(`It ended with ${wrong}.`), /^quotes "exit status 0"/, wrong)
    }
    assert.equal(verdict("Plain's tries can't pass."), 'kept', 'apostrophes are no quotes')
  })

  test('a sentence is kept as one line, with no control characters', () => {
    const v = checkSentence({ text: 'Plain passed 0 of 4\n\u001b[31mtries.', cites: [FACT] }, c)
    assert.ok('ok' in v)
    assert.equal(v.ok.text, 'Plain passed 0 of 4 [31mtries.')
  })
})

describe('what the run interrupt cancelled', () => {
  const ABORTED = { kind: 'aborted', message: 'The run was cancelled' } as const

  test('canary: a cancelled eval opens no findings or moved row, and its facts claim no effect', () => {
    const e = structuredClone(measure)
    e.outcome = 'cancelled'
    const before = slotsOf('finish', measure)
    const slots = slotsOf('finish', e)
    assert.ok(before.findings, 'the eval measures a change')
    assert.equal(slots.findings, false)
    const moved = (e.cells ?? []).filter((c) => c.effect === 'better' && c.outcome === 'pass')
    assert.ok(moved.length, 'a passing arm that helped')
    for (const c of moved) {
      assert.ok(before.rows.includes(c.path))
      assert.ok(!slots.rows.includes(c.path), c.path)
    }
    assert.ok(evalFacts(measure).some((f) => f.effect))
    assert.deepEqual(
      evalFacts(e).filter((f) => f.effect),
      [],
    )
  })

  test('canary: a cancelled case opens no row, and its cancelled tries are not counted', () => {
    const e = structuredClone(choose)
    const k = (e.cases ?? []).find((x) => x.label === 'a Python agent')
    const cell = k?.cells[0]
    assert.ok(k && cell?.failed)
    assert.ok(slotsOf('choose', choose).rows.includes(k.path))
    k.outcome = 'cancelled'
    cell.errors.push({ ...ABORTED, attempts: 1 })
    assert.ok(!slotsOf('choose', e).rows.includes(k.path))
    const facts = evalFacts(e)
    const counted = cell.passed + cell.failed - 1
    assert.equal(facts.find((f) => f.path === cell.path)?.passed, `0 of ${counted} tries`)
    assert.equal(facts.find((f) => f.path === cell.path)?.cancelled, 1)
    assert.equal(facts.find((f) => f.path === k.path)?.passed, `0 of ${counted} tries`)
  })

  test("canary: a cancelled attempt's final message is not an attempt the tools are named from", () => {
    const k = (choose.cases ?? []).find((x) => x.label === 'a chat app')
    assert.ok(k)
    const changed = structuredClone(record)
    const attempt = changed.evals.find((x) => x.id === k.id)?.attempts[0]
    assert.ok(attempt)
    const before = attemptTexts(record, choose)
    Object.assign(attempt, { outcome: 'fail', error: ABORTED })
    const after = attemptTexts(changed, choose)
    assert.equal(after.size, before.size - 1)
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
    const stored = storedFresh()
    const opts = { color: false, verbose: false, hint: false }
    const fresh = render(suite, stored, opts).join('\n')
    const plain = render(suite, null, opts).join('\n')
    const stale = render(suite, { ...stored, factsHash: 'sha256:other' }, opts).join('\n')
    assert.ok(stored.headline && fresh.includes(stored.headline.text))
    assert.ok(!stale.includes(stored.headline.text))
    assert.match(stale, /insights left out: insights\.json was written for other facts/)
    assert.equal(stale.replace(/\n.*insights left out.*/, ''), plain)
  })

  test('a hand-edited sentence prints on one line, with no escape sequences', () => {
    const stored = storedFresh()
    assert.ok(stored.headline)
    const edited = { ...stored, headline: { ...stored.headline, text: 'Two\nlines \u001b[2J.' } }
    const out = render(suite, edited, { color: false, verbose: false, hint: false })
    assert.ok(out.includes('Two lines [2J.'))
    assert.ok(!out.some((l) => l.includes('\u001b')))
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
  test('replaces remarks-only insights.json and keeps its remarks', async () => {
    const p = await fixture('fixtures/records/with-remarks')
    writeFileSync(join(p.dir, 'reeval.config.ts'), FAKE_CONFIG)
    writeFileSync(
      join(p.dir, 'insights.ts'),
      readFileSync(new URL('../scripts/output/project/insights.ts', import.meta.url), 'utf8'),
    )
    const runId = corpusEntries()
      .find((e) => e.name === 'with-remarks')
      ?.runs.at(-1)?.runId
    assert.ok(runId)
    const file = join(p.dir, HISTORY_DIR, runId, 'insights.json')
    const before = readableInsights(JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(before.model, 'none')
    assert.ok(before.remarks.length > 0)

    const r = await runCli(p.dir, ['analyze', runId, '--insights'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const after = readableInsights(JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(after.model, 'fake')
    assert.deepEqual(after.remarks, before.remarks)
    const again = await runCli(p.dir, ['analyze', runId, '--insights'])
    assert.match(again.stderr, /already exists, and insights are never rewritten/)
  })

  test('keeps remarks-only insights.json when the new insights are refused', async () => {
    const p = await fixture('fixtures/records/with-remarks')
    writeFileSync(join(p.dir, 'reeval.config.ts'), FAKE_CONFIG)
    writeFileSync(
      join(p.dir, 'insights.ts'),
      readFileSync(new URL('../scripts/output/project/insights.ts', import.meta.url), 'utf8'),
    )
    const runId = corpusEntries()
      .find((e) => e.name === 'with-remarks')
      ?.runs.at(-1)?.runId
    assert.ok(runId)
    const file = join(p.dir, HISTORY_DIR, runId, 'insights.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.remarks[0].text = `token ghp_${'a1B2'.repeat(9)}`
    const before = `${JSON.stringify(doc, null, 2)}\n`
    writeFileSync(file, before)

    const r = await runCli(p.dir, ['analyze', runId, '--insights'])
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /looks like it contains a secret/)
    assert.equal(readFileSync(file, 'utf8'), before)
  })

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
    assert.match(flags.stderr, /takes a run, --json and -v only, not --save/)

    const scratch = await runCli(p.dir, ['run', 'greets in French'])
    assert.ok(scratch.code === 0 || scratch.code === 1, scratch.stderr)
    const refused = await runCli(p.dir, ['analyze', 'latest', '--insights'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /already exists, and insights are never rewritten/)
    assert.ok(existsSync(file))

    writeFileSync(file, '<<<<<<< HEAD\n{')
    const conflicted = await runCli(p.dir, ['show', runId])
    assert.equal(conflicted.code, 0, conflicted.stderr)
    assert.match(conflicted.stderr, /warning: skipped .*insights\.json: it isn't valid JSON/)
    assert.equal(conflicted.stdout, before.stdout)
  })

  test('canary: with only a judge model, --insights refuses and writes nothing', async () => {
    const p = await fixture('fixtures/records/before-insights')
    writeFileSync(
      join(p.dir, 'reeval.config.ts'),
      FAKE_CONFIG.replace("import { insights } from './insights.ts'\n", '').replace(
        'analysis: { model: fakeAnalysis({ insights }) },',
        "judge: { model: 'google/gemini-3.8-flash' },",
      ),
    )
    const r = await runCli(p.dir, ['analyze', '--insights'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /--insights needs analysis\.model, and never uses the judge's model\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \} in .*reeval\.config\.ts/,
    )
    const [runId] =
      corpusEntries()
        .find((e) => e.name === 'before-insights')
        ?.runs.map((x) => x.runId) ?? []
    assert.ok(!existsSync(join(p.dir, HISTORY_DIR, runId as string, 'insights.json')))
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

  test('-v prints each sentence the checks removed and why, and the file keeps them', async () => {
    const p = await fixture('fixtures/records/before-insights')
    writeFileSync(
      join(p.dir, 'reeval.config.ts'),
      FAKE_CONFIG.replace("import { insights } from './insights.ts'\n", '').replace(
        'fakeAnalysis({ insights })',
        `fakeAnalysis({
    insights: (input) =>
      input.call === 'insights' && input.eval.name === 'greets in French'
        ? { answer: { text: 'It never greets in French.', cites: ['F999'] } }
        : {},
  })`,
      ),
    )
    const plain = await runCli(p.dir, ['analyze', '-v'])
    assert.equal(plain.code, 2)
    assert.match(plain.stderr, /takes -v only with --insights/)
    const r = await runCli(p.dir, ['analyze', '--insights', '-v'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /1 sentence removed by the checks/)
    assert.match(
      r.stderr,
      /removed {2}greets in French › answer: "It never greets in French\."\n {9}cites F999, which isn't a fact it was shown/,
    )
    const [runId] =
      corpusEntries()
        .find((e) => e.name === 'before-insights')
        ?.runs.map((x) => x.runId) ?? []
    const doc = readableInsights(
      JSON.parse(readFileSync(join(p.dir, HISTORY_DIR, runId as string, 'insights.json'), 'utf8')),
    )
    assert.deepEqual(doc.validation.drops, [
      {
        slot: 'greets in French › answer',
        text: 'It never greets in French.',
        reason: "cites F999, which isn't a fact it was shown",
      },
    ])
  })
})

describe('the order analysis.maxTokens is spent in', () => {
  const at = (over: Partial<EvalResult>) =>
    ({ outcome: 'pass', questions: [], across: 'none', ...over }) as EvalResult

  test('a failure, then made worse, then a compare, then an infra error, then a flaky pass, then the rest', () => {
    const rest = at({ name: 'rest' })
    const infra = at({ name: 'infra', outcome: 'infra_error' })
    const compare = at({ name: 'compare', across: 'harness' as EvalResult['across'] })
    const question = at({ name: 'question', questions: [{}] as EvalResult['questions'] })
    const worse = at({
      name: 'worse',
      cells: [{ effect: 'worse', checks: [] }] as unknown as EvalResult['cells'],
    })
    const fail = at({ name: 'fail', outcome: 'fail' })
    const flaky = at({
      name: 'flaky',
      cases: [
        { cells: [{ passed: 3, failed: 0, checks: [] }] },
        { cells: [{ passed: 2, failed: 1, checks: [] }] },
      ] as unknown as EvalResult['cases'],
    })
    assert.deepEqual(
      [rest, flaky, infra, compare, question, worse, fail].map(insightTier),
      [5, 4, 3, 2, 2, 1, 0],
    )
    assert.deepEqual(
      byPriority([rest, flaky, infra, compare, question, worse, fail]).map((e) => e.name),
      ['fail', 'worse', 'compare', 'question', 'infra', 'flaky', 'rest'],
    )
  })

  test('canary: a clean pass stays below a flaky one, whichever prints first', () => {
    const clean = at({
      name: 'clean',
      cells: [{ passed: 3, failed: 0, checks: [] }] as unknown as EvalResult['cells'],
    })
    const flaky = at({
      name: 'flaky',
      cells: [{ passed: 2, failed: 1, checks: [] }] as unknown as EvalResult['cells'],
    })
    assert.equal(insightTier(clean), 5)
    assert.deepEqual(
      byPriority([clean, flaky]).map((e) => e.name),
      ['flaky', 'clean'],
    )
  })

  test('within a tier the output order stands, and the same facts give the same order', () => {
    const evals = insightEvals(suite)
    const ordered = byPriority(evals)
    assert.deepEqual(byPriority(evals), ordered)
    const tiers = ordered.map(insightTier)
    assert.deepEqual(
      tiers,
      [...tiers].sort((a, b) => a - b),
    )
    for (let i = 1; i < ordered.length; i++) {
      if (tiers[i] !== tiers[i - 1]) continue
      assert.ok(
        evals.indexOf(ordered[i] as EvalResult) > evals.indexOf(ordered[i - 1] as EvalResult),
      )
    }
  })
})

describe('the analysis.maxTokens gate', () => {
  /** Starts evals in order while the gate allows, each using `uses`, and returns how many started. */
  const simulate = (maxTokens: number, uses: number[], concurrency = 8) => {
    const l = ledger(maxTokens)
    const flight: Array<{ held: number; uses: number }> = []
    let started = 0
    for (const tokens of uses) {
      for (;;) {
        if (flight.length >= concurrency) {
          const done = flight.shift() as { held: number; uses: number }
          settle(l, done.held, done.uses)
          continue
        }
        const next = admit(l)
        if (next !== 'wait') {
          if (next === 'start') {
            flight.push({ held: reserve(l), uses: tokens })
            started++
          }
          break
        }
        const done = flight.shift() as { held: number; uses: number }
        settle(l, done.held, done.uses)
      }
    }
    for (const done of flight.splice(0)) settle(l, done.held, done.uses)
    return { started, used: l.used }
  }

  test('a budget that fits exactly N evals starts N', () => {
    const each = FIRST_ESTIMATE
    for (const n of [1, 3, 8, 12]) {
      assert.deepEqual(
        simulate(n * each, Array(20).fill(each)),
        { started: n, used: n * each },
        `${n}`,
      )
    }
  })

  test('a budget under the first estimate starts no eval', () => {
    assert.deepEqual(simulate(FIRST_ESTIMATE - 1, Array(5).fill(1000)), { started: 0, used: 0 })
    assert.equal(admit(ledger(4000)), 'skip')
  })

  test('the estimate is the mean of the evals that finished', () => {
    const l = ledger(100_000)
    assert.equal(estimate(l), FIRST_ESTIMATE)
    settle(l, reserve(l), 2000)
    settle(l, reserve(l), 4000)
    assert.equal(estimate(l), 3000)
    assert.deepEqual(l, { maxTokens: 100_000, used: 6000, reserved: 0, finished: 2 })
  })

  test('an eval that does not fit waits while one is in flight, and is skipped when none is', () => {
    const l = ledger(10_000)
    const held = reserve(l)
    assert.equal(admit(l), 'wait')
    settle(l, held, 3000)
    assert.equal(admit(l), 'start', '3000 used + a 3000 estimate fits')
    settle(l, reserve(l), 7000)
    assert.equal(admit(l), 'skip', '10000 used leaves nothing')
  })

  test('cheaper evals than the estimate let more start; the overshoot is only what is in flight', () => {
    const { started, used } = simulate(30_000, Array(20).fill(2000))
    assert.equal(started, 15)
    assert.ok(used <= 30_000, `${used}`)
  })

  test('canary: an eval that used no tokens leaves the estimate as it was', () => {
    const l = ledger(12_000)
    settle(l, reserve(l), 0)
    assert.equal(estimate(l), FIRST_ESTIMATE, 'a failure before any usage is no measurement')
    assert.equal(admit(l), 'start')
    settle(l, reserve(l), 2000)
    settle(l, reserve(l), 0)
    assert.equal(estimate(l), 2000)
  })

  test('canary: an eval whose calls fail before any usage lets no more evals start at once', async () => {
    let first: string | undefined
    const doc = await generate(
      (input) => {
        if (input.call === 'headline') return recipeInsights(input)
        first ??= input.eval.path
        if (input.eval.path === first) throw new Error('the model is down')
        return recipeInsights(input)
      },
      { maxTokens: FIRST_ESTIMATE, concurrency: 8 },
    )
    assert.deepEqual(
      doc.failed?.map((f) => f.evalId),
      [first],
    )
    const used = doc.usage.inputTokens + doc.usage.outputTokens
    assert.ok(used <= FIRST_ESTIMATE, `the failure doesn't open the gate to every eval: ${used}`)
    assert.equal(doc.evals.length, 1)
    assert.equal(doc.budget?.skipped.length, insightEvals(suite).length - 2)
  })
})

describe('Ctrl-C during insights', () => {
  test('canary: a stop during the headline call leaves no eval to finish, so it writes no stopped list', async () => {
    const stop = new AbortController()
    const doc = await generate(
      (input) => {
        if (input.call !== 'headline') return recipeInsights(input)
        stop.abort(new Error('Ctrl-C'))
        return new Promise<FakeInsights>(() => {})
      },
      { signal: stop.signal },
    )
    assert.equal(doc.evals.length, insightEvals(suite).length)
    assert.equal(doc.headline, null)
    assert.equal(doc.stopped, undefined, 'no "insights stopped: 0 evals skipped" line to finish')
  })

  test('a stop while evals are in flight lists them in stopped', async () => {
    const stop = new AbortController()
    let asked = 0
    const doc = await generate(
      (input) => {
        if (input.call === 'classify' && ++asked === 3) {
          stop.abort(new Error('Ctrl-C'))
          return new Promise<FakeInsights>(() => {})
        }
        return recipeInsights(input)
      },
      { signal: stop.signal },
    )
    assert.ok(doc.stopped?.skipped.length, 'the evals left are listed')
    assert.equal(doc.evals.length + (doc.stopped?.skipped.length ?? 0), insightEvals(suite).length)
  })
})

describe('each call has a timeout and one retry', () => {
  test('a hung call is given up after its timeout, tried once more, then that eval prints its facts alone', async () => {
    const asked: string[] = []
    const doc = await generate(
      (input) => {
        if (input.call !== 'headline') asked.push(input.eval.path)
        if (input.call !== 'headline' && input.eval.path === choose.path) {
          return new Promise<FakeInsights>(() => {})
        }
        return recipeInsights(input)
      },
      { callTimeoutMs: 200 },
    )
    assert.deepEqual(doc.failed, [
      { evalId: choose.path, error: 'the classify call took longer than 200ms' },
    ])
    assert.equal(asked.filter((p) => p === choose.path).length, 2, 'tried once more, then left')
    assert.ok(!doc.evals.some((e) => e.evalId === choose.path))
    assert.equal(
      doc.evals.length,
      insightEvals(suite).length - 1,
      'every other eval has its insight',
    )
    assert.ok(doc.headline, 'the headline is still asked for')
  })

  test('canary: a slow call inside its timeout is kept', async () => {
    const doc = await generate(
      async (input) => {
        if (input.call !== 'headline' && input.eval.path === choose.path) {
          await new Promise((r) => setTimeout(r, 50))
        }
        return recipeInsights(input)
      },
      { callTimeoutMs: 2000 },
    )
    assert.equal(doc.failed, undefined)
    assert.ok(insightOf(doc, choose).answer)
  })
})

describe("each eval's input cap", () => {
  const fact = (path: string, kind: string, extra: Record<string, unknown> = {}): InsightFact => ({
    path,
    kind,
    ...extra,
  })
  /** A failing eval with many passing checks and tries, long messages and long transcripts. */
  const big = (): Omit<InsightInput, 'call'> => ({
    eval: {
      path: 'e',
      name: 'writes a greet module',
      group: [],
      file: 'evals/greet.eval.ts',
      across: 'none',
      family: false,
      verdict: 'fail',
    },
    prompts: ['Write greet.js. '.repeat(100)],
    judgeQuestions: [],
    checks: ['exports greet'],
    facts: [
      fact('e', 'eval', { name: 'writes a greet module', verdict: 'fail' }),
      fact('e/pass-cell', 'cell', { verdict: 'pass', passed: '3 of 3 tries' }),
      fact('e/fail-cell', 'cell', {
        verdict: 'fail',
        passed: '0 of 3 tries',
        errors: ['assertion: no greet.js'],
      }),
      fact('e/fail-cell/checks/greet', 'check', {
        label: 'exports greet',
        result: '0 of 3 passed',
        assertion: 'expected greet.js to exist',
      }),
      ...Array.from({ length: 40 }, (_, i) =>
        fact(`e/pass-cell/checks/${i}`, 'check', { label: `check ${i}`, result: '3 of 3 passed' }),
      ),
      fact('e/pass-cell/effort', 'effort', { toolCalls: 12, seconds: 30, tokens: 1000 }),
    ],
    attempts: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `e/pass-cell#${i + 1}`,
        cell: 'e/pass-cell',
        outcome: 'pass',
        lastText: 'I wrote greet.js and its test. '.repeat(48),
        lines: [],
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `e/fail-cell#${i + 1}`,
        cell: 'e/fail-cell',
        outcome: 'fail',
        lastText: 'I could not find the module. '.repeat(50),
        lines: Array.from(
          { length: 14 },
          (_, n) => `L${n + 1} ${'tool shell: ls -la '.repeat(10)}`,
        ),
      })),
    ],
  })
  const size = (x: unknown) => JSON.stringify(x).length

  test('under the cap the input is untouched', () => {
    const input = big()
    assert.equal(trimInput(input, size(input)), input)
  })

  test('over it, the trim is the same every time, fits, says what it cut and keeps the failing facts', () => {
    const cap = 8000
    const once = trimInput(big(), cap)
    assert.deepEqual(trimInput(big(), cap), once, 'deterministic')
    assert.ok(size(once) <= cap, `${size(once)}`)
    assert.ok(once.trimmed?.length, 'marked as trimmed')
    assert.equal(once.trimmed?.[0], "passing attempts' final messages", 'passing detail goes first')
    for (const path of ['e', 'e/fail-cell', 'e/fail-cell/checks/greet']) {
      assert.deepEqual(
        once.facts.find((f) => f.path === path),
        big().facts.find((f) => f.path === path),
        path,
      )
    }
    assert.ok(
      once.attempts.filter((a) => a.outcome === 'fail').length === 3,
      'every failing try stays, if shorter',
    )
  })

  test('canary: a passing check the layout opens a row on stays, whatever the cap', () => {
    const kept = trimInput(big(), 4000, ['e/pass-cell/checks/7'])
    assert.ok(kept.facts.some((f) => f.path === 'e/pass-cell/checks/7'))
    assert.ok(!kept.facts.some((f) => f.path === 'e/pass-cell/checks/8'))
  })

  test('the model is told the input was trimmed, and still gets the failing facts', async () => {
    const seen: FakeInsightsInput[] = []
    await generate(
      (input) => {
        if (input.call !== 'headline' && input.eval.path === choose.path) seen.push(input)
        return recipeInsights(input)
      },
      { maxInputChars: 1000 },
    )
    assert.ok(seen.length)
    for (const input of seen) {
      assert.ok(input.call !== 'headline' && input.trimmed?.length, input.call)
      assert.ok(input.call !== 'headline' && input.facts.some((f) => f.path === choose.path))
    }
  })
})

/** Nine passing evals, then one that fails: the budget reaches the failing one first. */
const RUN_EVALS = {
  'evals/files.eval.ts': `import { evaluate, expect } from 'reeval'
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  evaluate(\`writes ok.txt \${n}\`, async (c) => {
    await c.send('Write ok.txt')
    await expect(c).toHaveFile('ok.txt')
  })
}
evaluate('writes missing.txt', async (c) => {
  await c.send('Write missing.txt')
  await expect(c).toHaveFile('missing.txt')
})
`,
}

/** A compare whose variant passes both tries and whose baseline neither: a `too-few-tries` remark. */
const TOO_FEW_TRIES = `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate('skill helps', { runs: 2, compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  expect.soft(c.attempt.cell.role === 'variant', 'uses the marker').toBe(true)
})
`

/**
 * A fake harness and an insight model that logs each call (`<call> <eval>`) to calls.log.
 * `insights` replaces its answer; `analysis` adds keys to `analysis`.
 */
const runConfig = (
  o: { insights?: string; analysis?: string; vote?: string } = {},
) => `import { appendFileSync } from 'node:fs'
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
const log = (input) =>
  appendFileSync(new URL('./calls.log', import.meta.url), \`\${input.call} \${input.eval?.name ?? ''}\\n\`)
export default defineConfig({
  harness: fakeHarness({ files: { 'ok.txt': 'yes' } }),
  environment: defineEnvironment('fake', {
    sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  }),
  analysis: {
    model: fakeAnalysis({
      insights: ${
        o.insights ??
        `(input) => {
        log(input)
        if (input.call === 'headline') return {}
        return {
          intent: { job: 'finish' },
          answer: {
            text: input.eval.verdict === 'pass' ? 'Yes: every try passed.' : 'No: the file is missing.',
            cites: [input.facts[0]?.id ?? ''],
          },
        }
      }`
      },${o.vote ? `\n      vote: ${o.vote},` : ''}
    }),
    ${o.analysis ?? ''}
  },
})
`

const calls = (dir: string) =>
  existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
    : []

const scratchInsights = (dir: string) => {
  const { run } = readRun(dir)
  const file = join(dir, '.reeval/runs', run.runId, 'insights.json')
  return existsSync(file) ? readableInsights(JSON.parse(readFileSync(file, 'utf8'))) : null
}

/** The default fake's answers, with one eval's insights reply padded to `chars` of JSON. */
const padded = (name: string, chars: number) => `(input) => {
        log(input)
        if (input.call === 'headline') return {}
        const answer = {
          intent: { job: 'finish' },
          answer: { text: 'Yes: every try passed.', cites: [input.facts[0]?.id ?? ''] },
        }
        if (input.call !== 'insights' || input.eval.name !== '${name}') return answer
        const base = JSON.stringify({ answer: answer.answer, findings: [{ text: '', cites: [] }], rows: [], namedTools: [] }).length
        return { ...answer, findings: [{ text: 'x'.repeat(${chars} - base), cites: [] }] }
      }`

/**
 * The default fake's answers, at once for the failing eval and "writes ok.txt 1", after `ms` for
 * the rest; each answer it gives is logged as "answered <call> <eval>".
 */
const waiting = (ms: number) => `async (input) => {
        log(input)
        if (input.call === 'headline') return {}
        if (!['writes missing.txt', 'writes ok.txt 1'].includes(input.eval.name)) {
          await new Promise((r) => setTimeout(r, ${ms}).unref())
        }
        appendFileSync(new URL('./calls.log', import.meta.url), \`answered \${input.call} \${input.eval.name}\\n\`)
        return {
          intent: { job: 'finish' },
          answer: {
            text: input.eval.verdict === 'pass' ? 'Yes: every try passed.' : 'No: the file is missing.',
            cites: [input.facts[0]?.id ?? ''],
          },
        }
      }`

describe('reeval run writes insights at its end', () => {
  test('each eval gets its insight, printed under its block and written beside the record', async () => {
    const p = await project('run-insights', { 'reeval.config.ts': runConfig(), ...RUN_EVALS })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout + r.stderr,
      /insights: 10 evals with fake \(Ctrl-C skips the rest; --no-insights skips them all\)/,
    )
    assert.match(r.stdout, /No: the file is missing\./)
    assert.match(r.stdout, /Yes: every try passed\./)
    const doc = scratchInsights(p.dir)
    assert.ok(doc)
    assert.equal(doc.evals.length, 10)
    assert.deepEqual(doc.budget, { maxTokens: 250_000, skipped: [] })
    assert.ok(doc.usage.inputTokens > 0, 'the fake model counts its tokens')
    assert.equal(calls(p.dir).filter((c) => c.startsWith('classify ')).length, 10)
    const { run } = readRun(p.dir)
    assert.match(
      readFileSync(join(p.dir, '.reeval/runs', run.runId, 'summary.md'), 'utf8'),
      /No: the file is missing\./,
    )
  })

  test("the run's remarks go in the insights it writes, and stay remarks-only without them", async () => {
    const files = { 'evals/skill.eval.ts': TOO_FEW_TRIES }
    const p = await project('run-insights-remarks', { 'reeval.config.ts': runConfig(), ...files })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const doc = scratchInsights(p.dir)
    const { run } = readRun(p.dir)
    assert.equal(doc?.model, 'fake')
    assert.equal(doc?.evals.length, 1)
    assert.deepEqual(
      doc?.remarks.map((x) => [x.kind, x.origin, x.firstSeenRun]),
      [['too-few-tries', 'deterministic', run.runId]],
    )
    const tally = r.stdout.indexOf('1 pass')
    assert.ok(r.stdout.indexOf('Yes: every try passed.') < tally, r.stdout)
    assert.ok(r.stdout.indexOf('Remarks:\n  skill helps: Marked passed 2 of 2') > tally, r.stdout)
    assert.equal((await runCli(p.dir, ['record'])).code, 0)
    const recorded = readableInsights(
      JSON.parse(readFileSync(join(p.dir, HISTORY_DIR, run.runId, 'insights.json'), 'utf8')),
    )
    assert.equal(recorded.model, 'fake')
    assert.deepEqual(recorded.remarks, doc?.remarks)

    for (const [name, config, args] of [
      ['run-insights-remarks-off', runConfig(), ['run', '--no-insights', '-v']],
      ['run-insights-remarks-fail', runConfig({ insights: `() => { throw new Error('down') }` })],
    ] as const) {
      const q = await project(name, { 'reeval.config.ts': config, ...files })
      const quiet = await runCli(q.dir, [...(args ?? ['run', '-v'])])
      assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr)
      const only = scratchInsights(q.dir)
      assert.equal(only?.model, 'none', name)
      assert.deepEqual(
        only?.remarks.map((x) => x.kind),
        ['too-few-tries'],
      )
      assert.match(quiet.stdout, /Remarks:\n {2}skill helps: Marked passed 2 of 2/)
    }
  })

  test("canary: reeval record keeps a model's factsHash, so stale insights stay left out", async () => {
    const p = await project('run-insights-record-stale', {
      'reeval.config.ts': runConfig(),
      'evals/skill.eval.ts': TOO_FEW_TRIES,
    })
    const recorded = async (args: string[] = []) => {
      assert.equal((await runCli(p.dir, ['run'])).code, 0)
      const { run } = readRun(p.dir)
      const file = join(p.dir, '.reeval/runs', run.runId, 'insights.json')
      return { run, file, record: () => runCli(p.dir, ['record', ...args]) }
    }
    for (const args of [[], ['--artifacts', 'none']]) {
      const fresh = await recorded(args)
      const bytes = readFileSync(fresh.file, 'utf8')
      assert.equal((await fresh.record()).code, 0)
      const copy = join(p.dir, HISTORY_DIR, fresh.run.runId, 'insights.json')
      assert.equal(readFileSync(copy, 'utf8'), bytes, `copied byte for byte (${args})`)
      const shown = await runCli(p.dir, ['show', fresh.run.runId])
      assert.match(shown.stdout, /Yes: every try passed\./, `fresh insights print (${args})`)
      assert.doesNotMatch(shown.stdout, /insights left out/)
    }

    const stale = await recorded()
    const doc = JSON.parse(readFileSync(stale.file, 'utf8')) as RunInsights
    writeFileSync(stale.file, `${JSON.stringify({ ...doc, factsHash: 'stale' }, null, 2)}\n`)
    assert.equal((await stale.record()).code, 0)
    const copy = join(p.dir, HISTORY_DIR, stale.run.runId, 'insights.json')
    assert.equal(readableInsights(JSON.parse(readFileSync(copy, 'utf8'))).factsHash, 'stale')
    const shown = await runCli(p.dir, ['show', stale.run.runId])
    assert.match(shown.stdout, /insights left out: insights\.json was written for other facts/)
    assert.doesNotMatch(shown.stdout, /Yes: every try passed\./)
  })

  test('reeval analyze --insights keeps the remarks when it writes or finishes, and a refused one leaves the file', async () => {
    const p = await project('run-insights-remarks-analyze', {
      'reeval.config.ts': runConfig(),
      'evals/skill.eval.ts': TOO_FEW_TRIES,
    })
    assert.equal((await runCli(p.dir, ['run', '--no-insights'])).code, 0)
    const { run } = readRun(p.dir)
    const file = join(p.dir, '.reeval/runs', run.runId, 'insights.json')
    const remarks = scratchInsights(p.dir)?.remarks
    assert.equal(remarks?.length, 1)
    const written = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.equal(written.code, 0, written.stdout + written.stderr)
    const full = scratchInsights(p.dir)
    assert.equal(full?.model, 'fake')
    assert.deepEqual(full?.remarks, remarks)

    assert.ok(full)
    const stopped: RunInsights = {
      ...full,
      headline: null,
      evals: [],
      stopped: { signal: 'SIGINT', skipped: full.evals.map((e) => e.evalId) },
    }
    writeFileSync(file, `${JSON.stringify(stopped, null, 2)}\n`)
    const finished = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.equal(finished.code, 0, finished.stdout + finished.stderr)
    assert.match(finished.stderr, /finishing insights/)
    assert.equal(scratchInsights(p.dir)?.evals.length, 1)
    assert.deepEqual(scratchInsights(p.dir)?.remarks, remarks)

    const secret = `token ghp_${'a1B2'.repeat(9)}`
    const leaky = `${JSON.stringify(
      { ...stopped, remarks: stopped.remarks.map((x) => ({ ...x, text: secret })) },
      null,
      2,
    )}\n`
    writeFileSync(file, leaky)
    const refused = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /looks like it contains a secret/)
    assert.equal(readFileSync(file, 'utf8'), leaky)
    assert.deepEqual(
      readdirSync(join(p.dir, '.reeval/runs', run.runId)).filter((f) => f.includes('insights')),
      ['insights.json'],
    )
  })

  test('a small analysis.maxTokens skips the lowest-priority evals; the failing one keeps its insight', async () => {
    const p = await project('run-insights-budget', {
      'reeval.config.ts': runConfig({ analysis: 'maxTokens: 9000,' }),
      ...RUN_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const doc = scratchInsights(p.dir)
    assert.ok(doc)
    assert.equal(doc.budget?.maxTokens, 9000)
    assert.deepEqual(
      doc.evals.map((e) => e.evalId.replace('evals%2Ffiles.eval.ts › ', '')),
      ['writes ok.txt 1', 'writes ok.txt 2', 'writes missing.txt'],
      'the failing eval first, then the others in order while the next estimate fits',
    )
    assert.deepEqual(
      doc.budget?.skipped,
      [3, 4, 5, 6, 7, 8, 9].map((n) => `evals%2Ffiles.eval.ts › writes ok.txt ${n}`),
    )
    const used = doc.usage.inputTokens + doc.usage.outputTokens
    assert.ok(used <= 9000, `the run stays within its budget: ${used}`)
    assert.ok(
      doc.evals.some((e) => e.evalId === 'evals%2Ffiles.eval.ts › writes missing.txt' && e.answer),
      'the failing eval is explained first',
    )
    assert.ok(!calls(p.dir).some((c) => c.startsWith('headline')), 'no headline past the budget')
    assert.match(
      r.stdout,
      /insights skipped for 7 evals: analysis\.maxTokens \(9,000\) reached — raise it in reeval\.config\.ts, or reeval analyze \S+ --insights to finish/,
    )
    assert.match(r.stdout, /No: the file is missing\./)
  })

  test('canary: insights never change the exit code, whether they fail or are off', async () => {
    const off = await project('run-insights-off', {
      'reeval.config.ts': runConfig(),
      ...RUN_EVALS,
    })
    const skipped = await runCli(off.dir, ['run', '--no-insights'])
    assert.equal(skipped.code, 1, skipped.stdout + skipped.stderr)
    assert.deepEqual(calls(off.dir), [], '--no-insights makes no call')
    assert.equal(scratchInsights(off.dir), null)
    assert.doesNotMatch(skipped.stdout + skipped.stderr, /insights: /)

    const failing = await project('run-insights-fail', {
      'reeval.config.ts': runConfig({
        insights: `(input) => { log(input); throw new Error('the model is down') }`,
      }),
      ...RUN_EVALS,
    })
    const r = await runCli(failing.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /insights failed \(the model is down\): reeval analyze \S+ --insights to retry/,
    )
    assert.equal(scratchInsights(failing.dir), null)
    const classify = calls(failing.dir).filter((c) => c === 'classify writes missing.txt')
    assert.equal(classify.length, 2, 'a failed call is retried once')

    const passing = await project('run-insights-pass', {
      'reeval.config.ts': runConfig({
        insights: `() => { throw new Error('the model is down') }`,
      }),
      'evals/files.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes ok.txt', async (c) => {
  await c.send('Write ok.txt')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const ok = await runCli(passing.dir)
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /insights failed \(the model is down\)/)
  })

  test('analysis.insights: false makes no call', async () => {
    const p = await project('run-insights-config-off', {
      'reeval.config.ts': runConfig({ analysis: 'insights: false,' }),
      ...RUN_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.deepEqual(calls(p.dir), [])
    assert.equal(scratchInsights(p.dir), null)
  })

  test('a reply past the output cap is cut off and asked for once more, then that eval prints its facts alone', async () => {
    const over = INSIGHT_OUTPUT_TOKENS * 4 + 1000
    const p = await project('run-insights-cut-off', {
      'reeval.config.ts': runConfig({ insights: padded('writes ok.txt 3', over) }),
      ...RUN_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const doc = scratchInsights(p.dir)
    assert.ok(doc)
    assert.deepEqual(doc.failed, [
      {
        evalId: 'evals%2Ffiles.eval.ts › writes ok.txt 3',
        error: `the insights reply was cut off at ${INSIGHT_OUTPUT_TOKENS} output tokens`,
      },
    ])
    assert.equal(
      calls(p.dir).filter((c) => c === 'insights writes ok.txt 3').length,
      2,
      'the cut-off call is asked for once more',
    )
    assert.equal(doc.evals.length, 9, 'every other eval keeps its insight')
    assert.ok(!doc.evals.some((e) => e.evalId.endsWith('writes ok.txt 3')))
    assert.match(
      r.stdout,
      new RegExp(
        `insights failed for 1 eval \\(the insights reply was cut off at ${INSIGHT_OUTPUT_TOKENS} output tokens\\), so they print their facts`,
      ),
    )
    assert.match(r.stdout, /writes ok\.txt 2\n {2}Yes: every try passed\./)
    assert.match(r.stdout, /writes ok\.txt 3\n\n/, 'its block prints its facts alone')
  })

  test('canary: a reply just under the output cap is kept', async () => {
    const under = INSIGHT_OUTPUT_TOKENS * 4 - 1000
    const p = await project('run-insights-under-cap', {
      'reeval.config.ts': runConfig({ insights: padded('writes ok.txt 3', under) }),
      ...RUN_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const doc = scratchInsights(p.dir)
    assert.ok(doc)
    assert.equal(doc.failed, undefined)
    assert.equal(doc.evals.length, 10)
    assert.ok(doc.evals.find((e) => e.evalId.endsWith('writes ok.txt 3'))?.answer)
    assert.equal(calls(p.dir).filter((c) => c === 'insights writes ok.txt 3').length, 1)
  })

  test('Ctrl-C during insights keeps those written, skips the rest with a line, and keeps the exit code', {
    skip: noSignals,
  }, async () => {
    const p = await project('run-insights-sigint', {
      'reeval.config.ts': runConfig({ insights: waiting(60_000) }),
      ...RUN_EVALS,
    })
    const log = join(p.dir, 'calls.log')
    let poll: ReturnType<typeof setInterval> | undefined
    const r = await runCli(p.dir, ['run'], {
      onOutput: (stdout, pid) => {
        if (!/insights: 10 evals/.test(stdout)) return false
        poll = setInterval(() => {
          const lines = existsSync(log) ? readFileSync(log, 'utf8') : ''
          if ((lines.match(/^answered insights /gm) ?? []).length < 2) return
          if (!/^classify writes ok\.txt 2$/m.test(lines)) return
          clearInterval(poll)
          process.kill(-pid, 'SIGINT')
        }, 50)
        return true
      },
    })
    clearInterval(poll)
    assert.equal(r.code, 1, `the run's own exit code, not 130\n${r.stdout}${r.stderr}`)
    const doc = scratchInsights(p.dir)
    assert.ok(doc, 'insights.json holds what finished')
    assert.deepEqual(
      doc.evals.map((e) => e.evalId.replace('evals%2Ffiles.eval.ts › ', '')),
      ['writes ok.txt 1', 'writes missing.txt'],
    )
    assert.equal(doc.stopped?.signal, 'SIGINT')
    assert.deepEqual(
      doc.stopped?.skipped,
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `evals%2Ffiles.eval.ts › writes ok.txt ${n}`),
    )
    assert.equal(doc.failed, undefined, 'stopped calls are not failures')
    assert.equal(doc.headline, null)
    assert.ok(!calls(p.dir).some((c) => c.startsWith('headline')))
    assert.match(r.stdout, /insights stopped: 8 evals skipped \(Ctrl-C\)/)
    assert.match(r.stdout, /No: the file is missing\./)
    assert.doesNotMatch(r.stdout + r.stderr, /Cancelling/)
    const { run } = readRun(p.dir)
    assert.equal(run.status, 'complete')
    assert.match(
      r.stdout,
      new RegExp(`insights stopped: .*: reeval analyze ${run.runId} --insights to finish`),
    )
  })

  test('Ctrl-C after the last attempt, while compare questions settle, starts no insights and keeps the exit code', {
    skip: noSignals,
  }, async () => {
    const p = await project('run-insights-sigint-settle', {
      'reeval.config.ts': runConfig({
        vote: `() => {
        appendFileSync(new URL('./votes.log', import.meta.url), 'vote\\n')
        const until = Date.now() + 300
        while (Date.now() < until) {}
        return 'tie'
      }`,
      }),
      'evals/envs.ts': `import { defineEnvironment } from 'reeval'
export const base = defineEnvironment('base', {})
export const skilled = defineEnvironment('skilled', {})
`,
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('asks', { runs: 4, compare: { baseline: base, variants: [skilled], questions: ['Which is cleaner?', 'Which is shorter?'] } }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const staging = join(p.dir, '.reeval/staging')
    const finishing = () =>
      existsSync(staging) &&
      readdirSync(staging).some((id) => {
        const file = join(staging, id, 'live.json')
        return existsSync(file) && readFileSync(file, 'utf8').includes('"phase":"finishing"')
      })
    let poll: ReturnType<typeof setInterval> | undefined
    const r = await runCli(p.dir, ['run'], {
      onOutput: (_stdout, pid) => {
        poll = setInterval(() => {
          if (!existsSync(join(p.dir, 'votes.log')) || !finishing()) return
          clearInterval(poll)
          process.kill(-pid, 'SIGINT')
        }, 20)
        return true
      },
    })
    clearInterval(poll)
    assert.equal(r.code, 0, `the run's own exit code, not 130\n${r.stdout}${r.stderr}`)
    assert.deepEqual(calls(p.dir), [], 'no insight call starts')
    assert.doesNotMatch(r.stdout + r.stderr, /insights: 1 eval/)
    const { run } = readRun(p.dir)
    assert.match(
      r.stdout,
      new RegExp(
        `insights skipped \\(Ctrl-C\\): reeval analyze ${run.runId} --insights to write them`,
      ),
    )
    assert.equal(run.status, 'complete')
    assert.notEqual(scratchInsights(p.dir)?.model, 'fake')
  })

  test('reeval analyze --insights finishes a stopped document, keeping its sentences byte for byte', async () => {
    const p = await project('run-insights-finish', {
      'reeval.config.ts': runConfig(),
      ...RUN_EVALS,
    })
    assert.equal((await runCli(p.dir, ['run', '--no-insights'])).code, 1)
    const { run } = readRun(p.dir)
    const file = join(p.dir, '.reeval/runs', run.runId, 'insights.json')
    assert.equal(scratchInsights(p.dir), null)
    assert.equal((await runCli(p.dir, ['analyze', run.runId, '--insights'])).code, 0)
    const full = JSON.parse(readFileSync(file, 'utf8')) as RunInsights
    const stoppedAt = 3
    const kept = full.evals.slice(0, stoppedAt).map((e) => ({
      ...e,
      answer: e.answer && { ...e.answer, text: `Written before Ctrl-C: ${e.answer.text}` },
    }))
    const left = full.evals.slice(stoppedAt).map((e) => e.evalId)
    const stopped: RunInsights = {
      ...full,
      headline: null,
      evals: kept,
      stopped: { signal: 'SIGINT', skipped: left },
    }
    writeFileSync(file, `${JSON.stringify(stopped, null, 2)}\n`)
    writeFileSync(join(p.dir, 'calls.log'), '')

    const other = { ...stopped, promptVersion: 'insights-v0' }
    writeFileSync(file, `${JSON.stringify(other, null, 2)}\n`)
    const mixed = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.equal(mixed.code, 2, mixed.stdout + mixed.stderr)
    assert.match(mixed.stderr, /has unfinished evals, but it was written by fake \(insights-v0\)/)
    assert.deepEqual(calls(p.dir), [], 'a document asked with other prompts is never mixed')
    writeFileSync(file, `${JSON.stringify(stopped, null, 2)}\n`)

    const r = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /finishing insights for \S+ with fake: 7 evals left/)
    const asked = calls(p.dir).filter((c) => c.startsWith('insights '))
    assert.deepEqual(
      asked.sort(),
      left.map((id) => `insights ${id.replace('evals%2Ffiles.eval.ts › ', '')}`).sort(),
      'only the stopped evals are asked about',
    )
    assert.ok(
      calls(p.dir).some((c) => c.startsWith('headline')),
      'the missing headline is asked for',
    )
    const done = JSON.parse(readFileSync(file, 'utf8')) as RunInsights
    assert.equal(done.stopped, undefined, 'the list it filled is cleared')
    assert.equal(done.evals.length, 10)
    const before = new Map(kept.map((e) => [e.evalId, JSON.stringify(e)]))
    for (const e of done.evals.filter((e) => before.has(e.evalId))) {
      assert.equal(JSON.stringify(e), before.get(e.evalId), `${e.evalId} is kept byte for byte`)
    }
    assert.ok(done.usage.inputTokens > stopped.usage.inputTokens, 'usage adds the new calls')
    assert.deepEqual(
      readdirSync(join(file, '..')).filter((f) => f.includes('.partial')),
      [],
    )

    writeFileSync(join(p.dir, 'calls.log'), '')
    const text = readFileSync(file, 'utf8')
    const again = await runCli(p.dir, ['analyze', run.runId, '--insights'])
    assert.equal(again.code, 2, again.stdout + again.stderr)
    assert.match(again.stderr, /already exists, and insights are never rewritten/)
    assert.deepEqual(calls(p.dir), [], 'canary: a complete document is refused, and nothing asked')
    assert.equal(readFileSync(file, 'utf8'), text)
  })

  test('canary: with no Ctrl-C, every eval waits its turn and gets its insight', async () => {
    const p = await project('run-insights-no-sigint', {
      'reeval.config.ts': runConfig({ insights: waiting(200) }),
      ...RUN_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const doc = scratchInsights(p.dir)
    assert.ok(doc)
    assert.equal(doc.evals.length, 10)
    assert.equal(doc.stopped, undefined)
    assert.doesNotMatch(r.stdout, /insights stopped/)
  })

  test('a classification is cached by its key, and read back from the last recorded run', async () => {
    const p = await project('run-insights-cache', {
      'reeval.config.ts': runConfig(),
      ...RUN_EVALS,
    })
    const first = await runCli(p.dir, ['run', '--record'])
    assert.equal(first.code, 1, first.stdout + first.stderr)
    const cache = join(p.dir, '.reeval/analysis/classify')
    assert.equal(readdirSync(cache).length, 10, 'one cached classification per eval')
    assert.equal(calls(p.dir).filter((c) => c.startsWith('classify ')).length, 10)

    writeFileSync(join(p.dir, 'calls.log'), '')
    const hit = await runCli(p.dir)
    assert.equal(hit.code, 1, hit.stdout + hit.stderr)
    assert.deepEqual(
      calls(p.dir).filter((c) => c.startsWith('classify ')),
      [],
      'the second run classifies nothing',
    )
    assert.equal(scratchInsights(p.dir)?.evals.length, 10)

    rmSync(cache, { recursive: true })
    writeFileSync(join(p.dir, 'calls.log'), '')
    const readBack = await runCli(p.dir)
    assert.equal(readBack.code, 1, readBack.stdout + readBack.stderr)
    assert.deepEqual(
      calls(p.dir).filter((c) => c.startsWith('classify ')),
      [],
      "the recorded run's insights.json answers without the local cache",
    )
  })
})

test('real model: a well-named eval classifies to the job its name states', {
  skip:
    process.env.REEVAL_TEST_REAL === '1' ? false : 'set REEVAL_TEST_REAL=1 to call a real model',
  timeout: 300_000,
}, async () => {
  assert.ok(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    'GOOGLE_GENERATIVE_AI_API_KEY must be set for the real insights smoke',
  )
  const p = await project('run-insights-real', {
    'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: fakeHarness({ files: { 'greet.js': 'export const greet = (name) => \`Hello, \${name}!\`\\n' } }),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: { model: 'google/gemini-3.8-flash' },
})
`,
    'evals/greet.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes a greet(name) function that greets by name', async (c) => {
  await c.send('Create greet.js exporting greet(name), which returns "Hello, <name>!".')
  await expect(c).toHaveFile('greet.js')
})
`,
  })
  const r = await runCli(p.dir, ['run'], {
    env: { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY },
    timeoutMs: 240_000,
  })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const doc = scratchInsights(p.dir)
  assert.ok(doc, r.stdout + r.stderr)
  assert.equal(doc.model, 'google/gemini-3.8-flash')
  assert.deepEqual(
    doc.evals.map((e) => [e.intent.job, e.intent.name]),
    [['finish', 'states-intent']],
  )
  assert.ok(doc.usage.inputTokens > 0 && doc.usage.outputTokens > 0)
})
