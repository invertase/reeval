import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_ATTEMPT_QUESTION_STATE, DEFAULT_QUESTION_STATE } from '../src/compare/state.ts'
import type { QuestionCall } from '../src/types.ts'
import { fakeConfig, noSignals, project, readRun, runCli } from './helpers.ts'

describe('questions', () => {
  const ENVS = `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const base = defineEnvironment('base', { sandbox })
export const skilled = defineEnvironment('skilled', { sandbox })
`
  const asks = (question: string) => ({
    'evals/envs.ts': ENVS,
    'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('asks', { compare: { baseline: base, variants: [skilled] }, questions: ${question} }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
  })
  const PAIRWISE = `[{ question: 'Which is cleaner?', across: 'environment' }]`
  const OK = `fakeHarness({ files: { 'ok.txt': 'yes' } })`
  const noKeys = {
    ANTHROPIC_API_KEY: '',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
    OPENAI_API_KEY: '',
    AI_GATEWAY_API_KEY: '',
    VERCEL_OIDC_TOKEN: '',
  }

  /** The facts of `kind` in `reeval analyze`'s digest of the latest run. */
  async function digestFacts(dir: string, kind: string) {
    const out = await runCli(dir, ['analyze', '--context', '--vs', 'none'])
    assert.equal(out.code, 0, out.stderr)
    const json = /```json\n([\s\S]*?)\n```/.exec(out.stdout)?.[1]
    assert.ok(json)
    return (JSON.parse(json) as { facts: Array<Record<string, unknown>> }).facts.filter(
      (f) => f.kind === kind,
    )
  }

  test('--dry-run names the questions with no language model; reeval run exits 2 before any attempt', async () => {
    const p = await project('questions-no-model', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'ok.txt': 'yes' } }` }),
      ...asks(PAIRWISE),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is cleaner\? · after the run · shows task, diff · environment · 1 pair · needs a language model: set analysis\.model$/m,
    )
    const json = await runCli(p.dir, ['run', '--dry-run', '--json'])
    assert.equal(json.code, 0, json.stdout + json.stderr)
    assert.deepEqual(JSON.parse(json.stdout).evals[0].questions, [
      {
        question: 'Which is cleaner?',
        model: null,
        across: ['environment'],
        pairs: 1,
        shows: ['task', 'diff'],
      },
    ])
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /questions "Which is cleaner\?" \(evals\/q\.eval\.ts › asks\) needs a language model to answer it\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \} in reeval\.config\.ts \(the judge, a fake judge, is an evaluation model: it scores yes\/no questions and can't pick between two attempts\), or give the question its own, \{ question: '…', model: 'google\/gemini-3\.8-flash' \}, or set question: \{ model \} on its group or eval\./,
    )
    assert.doesNotMatch(r.stdout, /▶|^(pass|fail) /m, 'no attempt ran')
    assert.equal(existsSync(join(p.dir, '.reeval/runs')), false)
  })

  test('an evaluation model as the judge or the analysis model exits 2 at plan time', async () => {
    for (const [name, extra, judge, message] of [
      [
        'judge',
        '',
        `{ model: 'typesafe-ai/jev-1.14.0' }`,
        /needs a language model to answer it\. .* \(the judge, typesafe-ai\/jev-1\.14\.0, is an evaluation model: it scores yes\/no questions and can't pick between two attempts\)/,
      ],
      [
        'analysis',
        `analysis: { model: 'typesafe-ai/jev-1.14.0' },`,
        undefined,
        /questions "Which is cleaner\?" \(evals\/q\.eval\.ts › asks\) would be answered by analysis\.model in reeval\.config\.ts, "typesafe-ai\/jev-1\.14\.0", an evaluation model: it scores yes\/no questions and can't pick between two attempts\. Use a language model/,
      ],
    ] as const) {
      const p = await project(`questions-eval-model-${name}`, {
        'reeval.config.ts': fakeConfig({ extra, ...(judge ? { judge } : {}) }),
        ...asks(PAIRWISE),
      })
      const r = await runCli(p.dir, ['run'], { env: { TYPESAFE_AI_API_KEY: 'x' } })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, message)
      assert.equal(existsSync(join(p.dir, '.reeval/runs')), false)
    }
  })

  test("a question's own model needs its key, question.model cascades to the rest, and a malformed key exits 2", async () => {
    const p = await project('questions-models', {
      'reeval.config.ts': fakeConfig({
        harness: `{ files: { 'ok.txt': 'yes' } }`,
        extra: `question: { model: 'google/gemini-3.8-flash' },
  analysis: { model: fakeAnalysis({ vote: 'tie' }) },`,
      }).replace(
        "import { fakeJudge } from 'reeval/judge'",
        "import { fakeAnalysis, fakeJudge } from 'reeval/judge'",
      ),
      'evals/envs.ts': ENVS,
      'evals/q.eval.ts': `import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
evaluate('own model', { compare, questions: [{ question: 'Which is cleaner?', across: 'environment', model: 'anthropic/claude-sonnet-5' }] }, async () => {})
evaluate('cascade', { compare, questions: [{ question: 'Which is cleaner?', across: 'environment' }, { question: 'Which is shorter?', across: 'environment', model: 'openai/gpt-5.5' }] }, async () => {})
`,
    })
    const dry = await runCli(p.dir, ['run', '--dry-run', '--json'], { env: noKeys })
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    const planned = JSON.parse(dry.stdout).evals as Array<{
      name: string
      questions: Array<{ model: string }>
    }>
    assert.deepEqual(planned.find((e) => e.name === 'own model')?.questions, [
      {
        question: 'Which is cleaner?',
        model: 'anthropic/claude-sonnet-5',
        across: ['environment'],
        pairs: 1,
        shows: ['task', 'diff'],
      },
    ])
    assert.deepEqual(
      planned.find((e) => e.name === 'cascade')?.questions.map((q) => q.model),
      ['google/gemini-3.8-flash', 'openai/gpt-5.5'],
      'the config question.model over analysis.model; the entry over both',
    )
    const missing = await runCli(p.dir, ['run'], { env: noKeys })
    assert.equal(missing.code, 2, missing.stdout + missing.stderr)
    assert.match(
      missing.stderr,
      /Missing credentials: .*ANTHROPIC_API_KEY \(for direct\(\)\) for questions, "anthropic\/claude-sonnet-5"/,
    )
    assert.match(
      missing.stderr,
      /GOOGLE_GENERATIVE_AI_API_KEY \(for direct\(\)\) for questions, "google\/gemini-3\.8-flash"/,
    )
    const malformed = await runCli(p.dir, ['run'], {
      env: {
        ...noKeys,
        ANTHROPIC_API_KEY: 'sk-a\nrest',
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-not-real',
        OPENAI_API_KEY: 'sk-not-real',
      },
    })
    assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr)
    assert.match(
      malformed.stderr,
      /Credentials with whitespace or a line break in them: ANTHROPIC_API_KEY \(character 5\)/,
    )
  })

  // One run of single-harness compares whose checks all pass, so it exits 0: the fake vote ties
  // two questions, gives a reason on a third, and always picks the side shown first on the last.
  test('with a language model the questions are answered after the run, and the outcome is the checks', async () => {
    const p = await project('questions-answered', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: ${OK},
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: {
    model: fakeAnalysis({
      vote: (p) =>
        p.question === 'Which reads better?'
          ? { winner: 'A', reason: 'the first slot writes ok.txt' }
          : p.question === 'Which delivers a better user experience?'
            ? 'A'
            : 'tie',
    }),
  },
})
`,
      'evals/envs.ts': `${ENVS}export const none = defineEnvironment('no-skill', { sandbox })
export const current = defineEnvironment('current-skill', { sandbox })
export const next = defineEnvironment('new-skill', { sandbox })
`,
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, current, next, none, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
const body = async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
}
evaluate('two questions', { compare, questions: [{ question: 'Which is cleaner?', across: 'environment' }, { question: 'Which is shorter?', across: 'environment' }] }, body)
evaluate('reasons', { compare, questions: [{ question: 'Which reads better?', across: 'environment' }] }, body)
evaluate('three arms', { compare: { baseline: none, variants: [current, next], gate: 'none' }, questions: [{ question: 'Which delivers a better user experience?', across: 'environment' }], runs: 3 }, body)
`,
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/2 {2}Which is cleaner\? · after the run · shows task, diff · environment · 1 pair · fake$/m,
    )
    assert.match(
      dry.stdout,
      /^ {2}question 2\/2 {2}Which is shorter\? · after the run · shows task, diff · environment · 1 pair · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const run = readRun(p.dir)
    const named = (name: string) => run.evals.find((e) => e.name === name)

    const two = named('two questions')
    assert.equal(two?.outcome, 'pass')
    assert.deepEqual(
      two?.cells.map((c) => [c.role, c.outcome, c.pass, c.fail]),
      [
        ['control', 'pass', 1, 0],
        ['variant', 'pass', 1, 0],
      ],
    )
    assert.deepEqual(
      two?.answers?.map((a) => [a.question, a.votes.map((v) => v.winner), a.rates]),
      [
        ['Which is cleaner?', ['tie', 'tie'], []],
        ['Which is shorter?', ['tie', 'tie'], []],
      ],
    )

    // A vote's reason is recorded and left out of pass or fail; the result shows each side's wins.
    const reasons = named('reasons')
    assert.equal(reasons?.outcome, 'pass')
    assert.ok(
      reasons?.answers?.[0]?.votes.every((v) => v.reason === 'the first slot writes ok.txt'),
    )
    const reasonWins =
      /^ {2}question {2}Which reads better\?\n {4}base {11}won 1 of 2\n {4}skilled {8}won 1 of 2$/m
    assert.match(r.stdout, reasonWins)
    assert.match(run.read('summary.md'), reasonWins)

    // Three arms, three runs, and a vote for the side shown first: every pair splits with the
    // order, which the pooled rates (each arm 50%) and a "0 ties" count hide.
    assert.equal(named('three arms')?.answers?.[0]?.votes.length, 18)
    const armWins =
      /^ {2}question {2}Which delivers a better user experience\?\n {4}no-skill {7}won \d+ of \d+\n {4}current-skill {2}won \d+ of \d+\n {4}new-skill {6}won \d+ of \d+$/m
    assert.match(r.stdout, armWins)
    assert.match(run.read('summary.md'), armWins)
    const ux = `question = 'Which delivers a better user experience?'`
    const q = await runCli(p.dir, [
      'query',
      `SELECT a, b, pairs, a_wins, b_wins, ties, splits, splits_first FROM question_pairs WHERE ${ux}`,
      '--json',
    ])
    assert.equal(q.code, 0, q.stderr)
    assert.deepEqual(
      (JSON.parse(q.stdout) as Array<Record<string, unknown>>).map((x) => Object.values(x)),
      [
        ['no-skill', 'current-skill', 3, 0, 0, 0, 3, 3],
        ['no-skill', 'new-skill', 3, 0, 0, 0, 3, 3],
        ['current-skill', 'new-skill', 3, 0, 0, 0, 3, 3],
      ],
    )
    const votes = await runCli(p.dir, [
      'query',
      `SELECT COUNT(*) AS n FROM votes WHERE ${ux}`,
      '--json',
    ])
    assert.deepEqual(JSON.parse(votes.stdout), [{ n: 18 }])

    const facts = await digestFacts(p.dir, 'compare-question')
    assert.deepEqual(facts.find((f) => f.question === 'Which reads better?')?.reasons, [
      'the first slot writes ok.txt',
    ])
    const split = facts.find((f) => f.question === 'Which delivers a better user experience?')
    assert.equal(split?.splits, '9/9 pairs split by order, all to the side shown first')
    assert.deepEqual(split?.headToHead, [
      'within fake: no-skill 0–0 current-skill (3 splits) · no-skill 0–0 new-skill (3 splits) · current-skill 0–0 new-skill (3 splits)',
    ])
  })

  // One run on three harnesses: `two` writes an extra file, which the fake vote prefers, and `bad`
  // fails its check on every attempt, so it's in no pair but still in the pass rate and the exit
  // code. The fake model answers a question asked of each attempt from its diff.
  test('one run on three harnesses: pairs, votes and answers per question', async () => {
    const p = await project('questions-three-harnesses', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: [
    fakeHarness({ id: 'one', files: { 'ok.txt': 'yes' } }),
    fakeHarness({ id: 'two', files: { 'ok.txt': 'yes', 'extra.txt': 'more' } }),
    fakeHarness({ id: 'bad', files: { 'no.txt': 'no' } }),
  ],
  runs: 2,
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: {
    model: fakeAnalysis({
      vote: (p) => (p.a.diff?.includes('extra.txt') ? 'A' : p.b.diff?.includes('extra.txt') ? 'B' : 'tie'),
      answer: (q) => {
        const wrote = q.attempt.diff?.includes('ok.txt') ?? false
        if (q.question === 'Did it write ok.txt?') return { choice: wrote ? 'yes' : 'no', text: 'read the diff' }
        return \`saw \${wrote ? 'ok' : 'no'}.txt\`
      },
    }),
  },
})
`,
      'evals/envs.ts': ENVS,
      'evals/votes.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
const body = async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
}
evaluate('asks', { compare, questions: [{ question: 'Which is cleaner?', across: ['environment', 'harness'] }] }, body)
evaluate('plain', { compare }, body)
`,
      'evals/pairs.eval.ts': `import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { base, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
evaluate('across environment', { compare, questions: [{ question: 'Which is tidier?', across: 'environment' }] }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
for (const judged of [false, true]) {
  const options = { compare, harness: fakeHarness({ files: { 'ok.txt': 'yes' } }), runs: 1, judge: { model: fakeJudge({ score: 0.2 }) }, questions: [{ question: 'Which is neater?', across: 'environment' }] }
  evaluate(judged ? 'failed checks, judged' : 'failed checks', options, async (c) => {
    await c.send('go')
    if (judged) await c.judge('Is it nice?')
    await expect(c.exec('exit 1'), 'tests pass').toSucceed()
  })
}
`,
      'evals/each.eval.ts': `import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { base, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
const body = async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
}
evaluate('choices', { compare, questions: [{ question: 'Did it write ok.txt?', choices: ['yes', 'no'] }] }, body)
evaluate('free text', { compare, questions: ['What did it write?'] }, body)
evaluate('unrun command', { compare, questions: [{ question: 'What did it run?', state: { checks: ['npm tset'] } }] }, body)
const one = { harness: fakeHarness({ files: { 'ok.txt': 'yes' } }), runs: 1, questions: ['What did it do?'] }
evaluate('passes', one, async (c) => {
  await c.send('go')
})
evaluate('fails', one, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('missing.txt')
})
evaluate('broken agent', { ...one, harness: fakeHarness({ failWith: 'agent CLI failed to start' }) }, async (c) => {
  await c.send('go')
})
`,
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is tidier\? · after the run · shows task, diff · environment · 6 pairs · fake$/m,
    )
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Did it write ok\.txt\? · after each attempt · shows task, output, diff, transcript · each attempt · 12 attempts · yes \/ no · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const run = readRun(p.dir)
    const named = (name: string) => {
      const e = run.evals.find((x) => x.name === name)
      assert.ok(e, name)
      return e
    }

    // Votes are recorded after the attempts; the outcome and pass rate are the checks'.
    const e = named('asks')
    const w = named('plain')
    assert.equal(w.answers, undefined, 'no answers without questions')
    assert.deepEqual(
      [e.outcome, e.passRate, e.cells.map((c) => [c.key, c.outcome, c.pass, c.fail])],
      [w.outcome, w.passRate, w.cells.map((c) => [c.key, c.outcome, c.pass, c.fail])],
    )
    assert.equal(e.outcome, 'fail')
    assert.equal(e.passRate, 8 / 12, "bad's failures count in the pass rate")
    const [answer] = e.answers ?? []
    assert.ok(answer)
    assert.equal(answer.model, 'fake')
    assert.equal(answer.error, undefined)
    // Within: 2 harnesses with passing attempts × 2 runs; across: 2 arms × 2 runs, one vs two.
    assert.equal(answer.votes.length, 16)
    assert.ok(!answer.votes.some((v) => [v.a, v.b, v.harness].includes('bad')), 'bad is in no pair')
    assert.equal(answer.votes.filter((v) => v.swapped).length, 8)
    assert.deepEqual(
      answer.votes
        .filter((v) => v.cut === 'across')
        .map((v) => [v.arm, v.run, v.a, v.b, v.winner, v.swapped]),
      ['base', 'skilled'].flatMap((arm) =>
        [1, 2].flatMap((run) => [
          [arm, run, 'one', 'two', 'two', false],
          [arm, run, 'one', 'two', 'two', true],
        ]),
      ),
    )
    assert.deepEqual(
      answer.rates.filter((x) => x.cut === 'across'),
      [
        { cut: 'across', name: 'one', wins: 0, n: 8 },
        { cut: 'across', name: 'two', wins: 8, n: 8 },
      ],
    )
    const wins =
      /^ {2}question {2}Which is cleaner\?\n {4}base \(within\) {5}won 2 of 4\n {4}skilled \(within\) {2}won 2 of 4\n {4}one \(across\) {6}won 0 of 8\n {4}two \(across\) {6}won 8 of 8$/m
    assert.match(r.stdout, wins)
    assert.match(
      run.read('summary.md'),
      /^- Question: "Which is cleaner\?" · \[what the model saw\]\(evals-votes-eval-ts-asks-[0-9a-f]+\/questions\/1\.json\)$/m,
    )
    // One call per vote, in the same order; a vote's A is its a unless it's the swapped repeat.
    const input = JSON.parse(run.read(answer.input?.path ?? 'missing'))
    assert.deepEqual(
      input.calls.map((c: QuestionCall) => [c.cut, c.a, c.b, c.swapped, c.labels.A]),
      answer.votes.map((v) => [v.cut, v.a, v.b, v.swapped, v.swapped ? v.b : v.a]),
    )
    assert.ok(
      input.calls.every((c: { prompt: string }) =>
        c.prompt.startsWith('Question: Which is cleaner?'),
      ),
    )

    // across: 'environment' records only environment pairs.
    const [tidier] = named('across environment').answers ?? []
    assert.ok(tidier)
    assert.equal(tidier.votes.length, 8)
    assert.ok(tidier.votes.every((v) => v.cut === 'within'))
    assert.ok(!tidier.rates.some((x) => x.cut === 'across'))
    assert.match(
      r.stdout,
      /^ {2}question {2}Which is tidier\?\n {4}base {11}won 2 of 4\n {4}skilled {8}won 2 of 4$/m,
    )

    // Attempts whose checks failed are left out of the pairs, a verdict the eval didn't assert or not.
    for (const name of ['failed checks', 'failed checks, judged']) {
      assert.deepEqual(
        named(name).answers?.map((a) => [a.question, a.votes.length]),
        [['Which is neater?', 0]],
        name,
      )
    }

    // A question without across is asked of each attempt that ran to a pass or a fail, bad's
    // failed attempts too, and its choices are tallied.
    const chose = named('choices')
    assert.equal(chose.answers, undefined, 'no pairwise answers')
    const choices = chose.attempts.map((a) => [a.cell.split('/')[0], a.answers?.[0]?.choice])
    assert.equal(choices.length, 12)
    for (const [harness, choice] of choices) {
      assert.equal(choice, harness === 'bad' ? 'no' : 'yes', `${harness} answered ${choice}`)
    }
    const [first] = chose.attempts[0]?.answers ?? []
    assert.deepEqual(first?.stateOptions, DEFAULT_ATTEMPT_QUESTION_STATE)
    assert.equal(first?.text, 'read the diff')
    assert.match(first?.input?.path ?? '', /\/1\/questions\/1\.json$/)
    assert.equal(
      JSON.parse(run.read(first?.input?.path ?? 'missing')).question,
      'Did it write ok.txt?',
    )
    const tally = /^ {2}question {2}Did it write ok\.txt\?\n {4}yes 8 · no 4$/m
    assert.match(r.stdout, tally)
    assert.match(run.read('summary.md'), /Did it write ok\.txt\?/)
    const okTxt = `question = 'Did it write ok.txt?'`
    const byOutcome = await runCli(p.dir, [
      'query',
      `SELECT choice, outcome, COUNT(*) AS n FROM attempt_answers WHERE ${okTxt} GROUP BY choice, outcome ORDER BY choice`,
      '--json',
    ])
    assert.equal(byOutcome.code, 0, byOutcome.stderr)
    assert.deepEqual(JSON.parse(byOutcome.stdout), [
      { choice: 'no', outcome: 'fail', n: 4 },
      { choice: 'yes', outcome: 'pass', n: 8 },
    ])
    const byCell = await runCli(p.dir, [
      'query',
      `SELECT harness, role, choice, COUNT(*) AS n FROM attempt_answers WHERE ${okTxt} GROUP BY harness, role, choice ORDER BY harness, role`,
      '--json',
    ])
    assert.equal(byCell.code, 0, byCell.stderr)
    assert.deepEqual(JSON.parse(byCell.stdout), [
      { harness: 'bad', role: 'control', choice: 'no', n: 2 },
      { harness: 'bad', role: 'variant', choice: 'no', n: 2 },
      { harness: 'one', role: 'control', choice: 'yes', n: 2 },
      { harness: 'one', role: 'variant', choice: 'yes', n: 2 },
      { harness: 'two', role: 'control', choice: 'yes', n: 2 },
      { harness: 'two', role: 'variant', choice: 'yes', n: 2 },
    ])
    const facts = await digestFacts(p.dir, 'attempt-question')
    assert.deepEqual(facts.find((f) => f.question === 'Did it write ok.txt?')?.choices, [
      { choice: 'yes', n: 8 },
      { choice: 'no', n: 4 },
    ])

    // A free-text question asked of each attempt shows its answers.
    assert.match(r.stdout, /^ {2}question {2}What did it write\?\n {4}\S+ +saw (ok|no)\.txt$/m)

    // A per-attempt question naming a command no attempt ran is warned about once.
    const unrun =
      'question "What did it run?" state.checks names a command no attempt ran: "npm tset"'
    assert.deepEqual(
      r.stdout.split('\n').filter((l) => l.includes('names a command no attempt ran')),
      [
        `${unrun} on evals/each.eval.ts › unrun command, so each attempt's answer is that error. Outcomes are unchanged.`,
        `    12 of 12 not answered: ${unrun}`,
      ],
    )
    for (const a of named('unrun command').attempts) assert.equal(a.answers?.[0]?.error, unrun)

    // An attempt that passed or failed is asked; an infra error's isn't.
    assert.deepEqual(
      ['passes', 'fails', 'broken agent'].map((name) => {
        const x = named(name)
        return [x.name, x.outcome, x.attempts[0]?.answers?.[0]?.text]
      }),
      [
        ['passes', 'pass', 'saw ok.txt'],
        ['fails', 'fail', 'saw ok.txt'],
        ['broken agent', 'infra_error', undefined],
      ],
    )

    const agent = await runCli(p.dir, ['run', '--ui', 'agent', 'votes.eval'])
    assert.equal(agent.code, 1, agent.stdout + agent.stderr)
    assert.match(agent.stdout, wins)
    // Recorded, the input goes with the eval's other files, and is unset where those aren't kept.
    const kept = await runCli(p.dir, ['record', 'latest', '--artifacts', 'all'])
    assert.equal(kept.code, 0, kept.stdout + kept.stderr)
    const all = readRun(p.dir, { history: 'evals/.history' })
    const keptAnswer = all.evals.find((x) => x.name === 'asks')?.answers?.[0]
    assert.deepEqual(JSON.parse(all.read(keptAnswer?.input?.path ?? 'missing')), input)
    const bare = await runCli(p.dir, ['record', run.run.runId, '--artifacts', 'none'])
    assert.equal(bare.code, 0, bare.stdout + bare.stderr)
    const none = readRun(p.dir, { history: 'evals/.history', back: 1 })
    assert.equal(none.run.runId, run.run.runId)
    assert.equal(none.evals.find((x) => x.name === 'asks')?.answers?.[0]?.input, undefined)
  })

  test('a model error is kept on its answer and warned about; the outcome and exit code stand', async () => {
    const p = await project('questions-model-error', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: ${OK},
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: {
    model: fakeAnalysis({
      vote: { error: 'the model is over quota' },
      answer: { error: 'the model is over quota' },
    }),
  },
})
`,
      'evals/envs.ts': ENVS,
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
const compare = { baseline: base, variants: [skilled] }
const body = async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
}
evaluate('asks', { compare, questions: ${PAIRWISE} }, body)
evaluate('describes', { compare, questions: ['What did it write?'] }, body)
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /question "Which is cleaner\?" on evals\/q\.eval\.ts › asks failed: the model is over quota\. Outcomes are unchanged\./,
    )
    assert.match(
      r.stdout,
      /^ {2}question {2}Which is cleaner\?\n {4}the model call failed: the model is over quota$/m,
    )
    const run = readRun(p.dir)
    const e = run.evals.find((x) => x.name === 'asks')
    assert.equal(e?.outcome, 'pass')
    const { input, ...answer } = e?.answers?.[0] ?? {}
    assert.deepEqual(answer, {
      question: 'Which is cleaner?',
      model: 'fake',
      stateOptions: DEFAULT_QUESTION_STATE,
      votes: [],
      rates: [],
      error: 'the model is over quota',
    })
    // The calls in flight when the first failed are saved too, each with its error.
    const { calls } = JSON.parse(run.read(input?.path ?? 'missing'))
    assert.ok(calls.length >= 1, JSON.stringify(calls))
    for (const call of calls) assert.equal(call.error, 'the model is over quota')

    // A failed call of a question asked of each attempt is kept on each attempt's answer.
    assert.match(r.stdout, /question "What did it write\?" on .* failed: the model is over quota/)
    assert.match(
      r.stdout,
      /^ {2}question {2}What did it write\?\n {4}2 of 2 not answered: the model is over quota$/m,
    )
    const described = run.evals.find((x) => x.name === 'describes')
    assert.equal(described?.outcome, 'pass')
    for (const a of described?.attempts ?? []) {
      assert.equal(a.answers?.[0]?.error, 'the model is over quota')
      assert.equal(a.answers?.[0]?.text, '')
    }
  })

  test('Ctrl-C while questions are answered stops the run and records each unanswered one', {
    skip: noSignals,
  }, async () => {
    // A model that never replies, so the signal lands while every call is in flight. Two
    // per-attempt calls and then the pairwise one: the third means both attempts have ended.
    let asked = 0
    const server = createServer(() => {
      asked++
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    try {
      const p = await project('questions-sigint', {
        'reeval.config.ts': fakeConfig({ harness: `{ files: { 'ok.txt': 'yes' } }` }),
        ...asks(
          `[{ question: 'Which is cleaner?', across: 'environment', model: 'openai/gpt-5.6-luna' }, { question: 'What did it write?', model: 'openai/gpt-5.6-luna' }]`,
        ),
      })
      let poll: ReturnType<typeof setInterval> | undefined
      const r = await runCli(p.dir, ['run'], {
        env: {
          ...noKeys,
          OPENAI_API_KEY: 'sk-test',
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        },
        onOutput: (_, pid) => {
          poll = setInterval(() => {
            if (asked < 3) return
            clearInterval(poll)
            process.kill(-pid, 'SIGINT')
          }, 50)
          return true
        },
      })
      clearInterval(poll)
      assert.equal(r.code, 130, r.stdout + r.stderr)
      const run = readRun(p.dir)
      assert.equal(run.run.status, 'interrupted')
      const [e] = run.evals
      assert.equal(e?.answers, undefined, 'an aborted pairwise call is not a failed answer')
      assert.equal(e?.attempts.length, 2)
      for (const a of e?.attempts ?? []) {
        assert.equal(a.outcome, 'pass')
        assert.deepEqual(
          a.answers?.map((x) => [x.question, x.error]),
          [['What did it write?', 'the run stopped before it was answered']],
        )
      }
      assert.doesNotMatch(r.stdout, /aborted/)
      assert.match(r.stdout, /^ {4}2 of 2 not answered: the run stopped before it was answered$/m)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
