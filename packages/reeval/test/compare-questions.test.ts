import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_QUESTION_STATE } from '../src/compare/state.ts'
import type { QuestionCall } from '../src/types.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

describe('compare questions', () => {
  const asks = (question: string) => ({
    'evals/envs.ts': `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const base = defineEnvironment('base', { sandbox })
export const skilled = defineEnvironment('skilled', { sandbox })
`,
    'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('asks', { compare: { baseline: base, variants: [skilled], questions: ${question} } }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
  })
  const OK = `fakeHarness({ files: { 'ok.txt': 'yes' } })`
  const noKeys = {
    ANTHROPIC_API_KEY: '',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
    OPENAI_API_KEY: '',
    AI_GATEWAY_API_KEY: '',
    VERCEL_OIDC_TOKEN: '',
  }

  test('--dry-run names the questions with no language model; reeval run exits 2 before any attempt', async () => {
    const p = await project('questions-no-model', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'ok.txt': 'yes' } }` }),
      ...asks(`['Which is cleaner?']`),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is cleaner\? · after the run · shows task, diff · 1 pair · needs a language model: set analysis\.model$/m,
    )
    const json = await runCli(p.dir, ['run', '--dry-run', '--json'])
    assert.equal(json.code, 0, json.stdout + json.stderr)
    assert.deepEqual(JSON.parse(json.stdout).evals[0].questions, [
      { question: 'Which is cleaner?', model: null, pairs: 1, shows: ['task', 'diff'] },
    ])
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /compare\.questions "Which is cleaner\?" \(evals\/q\.eval\.ts › asks\) needs a language model to answer it\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \} in reeval\.config\.ts \(the judge, a fake judge, is an evaluation model: it scores yes\/no questions and can't pick between two attempts\), or give the question its own, \{ question: '…', model: 'google\/gemini-3\.8-flash' \}, or set question: \{ model \} on its group or eval\./,
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
        /compare\.questions "Which is cleaner\?" \(evals\/q\.eval\.ts › asks\) would be answered by analysis\.model in reeval\.config\.ts, "typesafe-ai\/jev-1\.14\.0", an evaluation model: it scores yes\/no questions and can't pick between two attempts\. Use a language model/,
      ],
    ] as const) {
      const p = await project(`questions-eval-model-${name}`, {
        'reeval.config.ts': fakeConfig({ extra, ...(judge ? { judge } : {}) }),
        ...asks(`['Which is cleaner?']`),
      })
      const r = await runCli(p.dir, ['run'], { env: { TYPESAFE_AI_API_KEY: 'x' } })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, message)
      assert.equal(existsSync(join(p.dir, '.reeval/runs')), false)
    }
  })

  test("a question's own model needs its key, and a malformed one exits 2", async () => {
    const p = await project('questions-own-model', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'ok.txt': 'yes' } }` }),
      ...asks(`[{ question: 'Which is cleaner?', model: 'google/gemini-3.8-flash' }]`),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run', '--json'], { env: noKeys })
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.deepEqual(JSON.parse(dry.stdout).evals[0].questions, [
      {
        question: 'Which is cleaner?',
        model: 'google/gemini-3.8-flash',
        pairs: 1,
        shows: ['task', 'diff'],
      },
    ])
    const missing = await runCli(p.dir, ['run'], { env: noKeys })
    assert.equal(missing.code, 2, missing.stdout + missing.stderr)
    assert.match(
      missing.stderr,
      /Missing credentials: GOOGLE_GENERATIVE_AI_API_KEY \(to call Google directly\) or AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN \(to go through the Vercel AI Gateway\) for compare questions, "google\/gemini-3\.8-flash"\./,
    )
    const malformed = await runCli(p.dir, ['run'], {
      env: { ...noKeys, GOOGLE_GENERATIVE_AI_API_KEY: 'AIza\nrest' },
    })
    assert.equal(malformed.code, 2, malformed.stdout + malformed.stderr)
    assert.match(
      malformed.stderr,
      /Credentials with whitespace or a line break in them: GOOGLE_GENERATIVE_AI_API_KEY \(character 5\)/,
    )
  })

  test("question.model cascades to every question without its own; an entry's model wins", async () => {
    const p = await project('questions-option-model', {
      'reeval.config.ts': fakeConfig({
        harness: `{ files: { 'ok.txt': 'yes' } }`,
        extra: `question: { model: 'google/gemini-3.8-flash' },
  analysis: { model: fakeAnalysis({ vote: 'tie' }) },`,
      }).replace(
        "import { fakeJudge } from 'reeval/judge'",
        "import { fakeAnalysis, fakeJudge } from 'reeval/judge'",
      ),
      ...asks(`['Which is cleaner?', { question: 'Which is shorter?', model: 'openai/gpt-5.5' }]`),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run', '--json'], { env: noKeys })
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.deepEqual(
      JSON.parse(dry.stdout).evals[0].questions.map((q: { model: string }) => q.model),
      ['google/gemini-3.8-flash', 'openai/gpt-5.5'],
      'the config question.model over analysis.model; the entry over both',
    )
    const missing = await runCli(p.dir, ['run'], { env: noKeys })
    assert.equal(missing.code, 2, missing.stdout + missing.stderr)
    assert.match(
      missing.stderr,
      /Missing credentials: GOOGLE_GENERATIVE_AI_API_KEY \(to call Google directly\) or AI_GATEWAY/,
    )
  })

  test('with a language model the run plans its questions and the outcome is the checks', async () => {
    const p = await project('questions-fake-model', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: ${OK},
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ output: {} }) },
})
`,
      ...asks(`['Which is cleaner?', 'Which is shorter?']`),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/2 {2}Which is cleaner\? · after the run · shows task, diff · 1 pair · fake$/m,
    )
    assert.match(
      dry.stdout,
      /^ {2}question 2\/2 {2}Which is shorter\? · after the run · shows task, diff · 1 pair · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'pass')
    assert.deepEqual(
      e?.cells.map((c) => [c.role, c.outcome, c.pass, c.fail]),
      [
        ['control', 'pass', 1, 0],
        ['variant', 'pass', 1, 0],
      ],
    )
    // fakeAnalysis() without a vote calls every pair a tie.
    assert.deepEqual(
      e?.answers?.map((a) => [a.question, a.votes.map((v) => v.winner), a.rates]),
      [
        ['Which is cleaner?', ['tie', 'tie'], []],
        ['Which is shorter?', ['tie', 'tie'], []],
      ],
    )
  })

  test('a vote reason is recorded, shown and left out of pass or fail', async () => {
    const p = await project('questions-vote-reason', {
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
      vote: { winner: 'A', reason: 'the first slot writes ok.txt' },
    }),
  },
})
`,
      ...asks(`['Which is cleaner?']`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'pass')
    assert.ok(e?.answers?.[0]?.votes.every((v) => v.reason === 'the first slot writes ok.txt'))
    // The reasons are for analysis: the result shows each side's wins.
    const wins =
      /^ {2}question {2}Which is cleaner\?\n {4}base {11}won 1 of 2\n {4}skilled {8}won 1 of 2$/m
    assert.match(r.stdout, wins)
    assert.match(readRun(p.dir).read('summary.md'), wins)
    const { digest } = await (async () => {
      const out = await runCli(p.dir, ['analyze', '--context', '--vs', 'none'])
      assert.equal(out.code, 0, out.stderr)
      const json = /```json\n([\s\S]*?)\n```/.exec(out.stdout)?.[1]
      assert.ok(json)
      return { digest: JSON.parse(json) as { facts: Array<Record<string, unknown>> } }
    })()
    const fact = digest.facts.find((f) => f.kind === 'compare-question')
    assert.deepEqual(fact?.reasons, ['the first slot writes ok.txt'])
  })

  // Three arms, three runs, and a vote that always picks the side shown first: every pair splits
  // with the order, which the pooled rates (each arm 50%) and a "0 ties" count hide.
  test('three arms: head to head per pair, and pairs the order decided are splits', async () => {
    const p = await project('questions-splits', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: ${OK},
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ vote: 'A' }) },
})
`,
      'evals/envs.ts': `import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })
export const none = defineEnvironment('no-skill', { sandbox })
export const current = defineEnvironment('current-skill', { sandbox })
export const next = defineEnvironment('new-skill', { sandbox })
`,
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { current, next, none } from './envs.ts'
evaluate('asks', { compare: { baseline: none, variants: [current, next], gate: 'none', questions: ['Which delivers a better user experience?'] }, runs: 3 }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.answers?.[0]?.votes.length, 18)
    const wins =
      /^ {2}question {2}Which delivers a better user experience\?\n {4}no-skill {7}won \d+ of \d+\n {4}current-skill {2}won \d+ of \d+\n {4}new-skill {6}won \d+ of \d+$/m
    assert.match(r.stdout, wins)
    assert.match(readRun(p.dir).read('summary.md'), wins)
    const q = await runCli(p.dir, [
      'query',
      'SELECT a, b, pairs, a_wins, b_wins, ties, splits, splits_first FROM question_pairs',
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
    const votes = await runCli(p.dir, ['query', 'SELECT COUNT(*) AS n FROM votes', '--json'])
    assert.deepEqual(JSON.parse(votes.stdout), [{ n: 18 }])
    const out = await runCli(p.dir, ['analyze', '--context', '--vs', 'none'])
    assert.equal(out.code, 0, out.stderr)
    const json = /```json\n([\s\S]*?)\n```/.exec(out.stdout)?.[1]
    assert.ok(json)
    const fact = (JSON.parse(json) as { facts: Array<Record<string, unknown>> }).facts.find(
      (f) => f.kind === 'compare-question',
    )
    assert.equal(fact?.splits, '9/9 pairs split by order, all to the side shown first')
    assert.deepEqual(fact?.headToHead, [
      'within fake: no-skill 0–0 current-skill (3 splits) · no-skill 0–0 new-skill (3 splits) · current-skill 0–0 new-skill (3 splits)',
    ])
  })

  // Three harnesses: `two` writes an extra file, which the fake vote prefers, and `bad` fails
  // its check on every attempt, so it's in no pair but still in the pass rate and the exit code.
  const threeHarnesses = (
    analysis: string,
  ) => `import { defineConfig, defineEnvironment } from 'reeval'
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
  ${analysis}
})
`
  const extra = `analysis: { model: fakeAnalysis({ vote: (p) => (p.a.diff?.includes('extra.txt') ? 'A' : p.b.diff?.includes('extra.txt') ? 'B' : 'tie') }) },`

  test('votes are recorded after the attempts, and the outcome and exit code are the checks', async () => {
    const asked = await project('questions-votes', {
      'reeval.config.ts': threeHarnesses(extra),
      ...asks(`['Which is cleaner?']`),
    })
    const plain = await project('questions-votes-none', {
      'reeval.config.ts': threeHarnesses(extra),
      ...asks(`undefined`),
    })
    const r = await runCli(asked.dir)
    const without = await runCli(plain.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.equal(r.code, without.code, 'the exit code is the checks’')
    const [e] = readRun(asked.dir).evals
    const [w] = readRun(plain.dir).evals
    assert.ok(e && w)
    assert.equal(w.answers, undefined, 'no answers without questions')
    assert.deepEqual(
      [e.outcome, e.passRate, e.cells.map((c) => [c.key, c.outcome, c.pass, c.fail])],
      [w.outcome, w.passRate, w.cells.map((c) => [c.key, c.outcome, c.pass, c.fail])],
    )
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
    const run = readRun(asked.dir)
    assert.match(
      run.read('summary.md'),
      /^- Question: "Which is cleaner\?" · \[what the model saw\]\(evals-q-eval-ts-asks-[0-9a-f]+\/questions\/1\.json\)$/m,
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
    const agent = await runCli(asked.dir, ['run', '--ui', 'agent'])
    assert.equal(agent.code, 1, agent.stdout + agent.stderr)
    assert.match(agent.stdout, wins)
    // Recorded, the input goes with the eval's other files, and is unset where those aren't kept.
    const kept = await runCli(asked.dir, ['record', 'latest', '--artifacts', 'all'])
    assert.equal(kept.code, 0, kept.stdout + kept.stderr)
    const all = readRun(asked.dir, { history: 'evals/.history' })
    const [keptAnswer] = all.evals[0]?.answers ?? []
    assert.deepEqual(JSON.parse(all.read(keptAnswer?.input?.path ?? 'missing')), input)
    const bare = await runCli(asked.dir, ['record', run.run.runId, '--artifacts', 'none'])
    assert.equal(bare.code, 0, bare.stdout + bare.stderr)
    const none = readRun(asked.dir, { history: 'evals/.history', back: 1 })
    assert.equal(none.run.runId, run.run.runId)
    assert.equal(none.evals[0]?.answers?.[0]?.input, undefined)
  })

  test('a question with across: environment records only environment pairs', async () => {
    const p = await project('questions-across-environment', {
      'reeval.config.ts': threeHarnesses(extra),
      ...asks(`[{ question: 'Which is cleaner?', across: 'environment' }]`),
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is cleaner\? · after the run · shows task, diff · environment · 6 pairs · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [answer] = readRun(p.dir).evals[0]?.answers ?? []
    assert.ok(answer)
    assert.equal(answer.votes.length, 8)
    assert.ok(answer.votes.every((v) => v.cut === 'within'))
    assert.ok(!answer.rates.some((x) => x.cut === 'across'))
    assert.match(
      r.stdout,
      /^ {2}question {2}Which is cleaner\?\n {4}base {11}won 2 of 4\n {4}skilled {8}won 2 of 4$/m,
    )
  })

  test('compare.across sets the default factor for questions that omit it', async () => {
    const p = await project('questions-compare-across', {
      'reeval.config.ts': threeHarnesses(extra),
      'evals/envs.ts': asks(`['Which is cleaner?']`)['evals/envs.ts'],
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('asks', { compare: { baseline: base, variants: [skilled], across: 'environment', questions: ['Which is cleaner?'] } }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is cleaner\? · after the run · shows task, diff · environment · 6 pairs · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [answer] = readRun(p.dir).evals[0]?.answers ?? []
    assert.ok(answer)
    assert.equal(answer.votes.length, 8)
    assert.ok(answer.votes.every((v) => v.cut === 'within'))
  })

  test('a question across overrides compare.across', async () => {
    const p = await project('questions-across-override', {
      'reeval.config.ts': threeHarnesses(extra),
      'evals/envs.ts': asks(`['Which is cleaner?']`)['evals/envs.ts'],
      'evals/q.eval.ts': `import { evaluate, expect } from 'reeval'
import { base, skilled } from './envs.ts'
evaluate('asks', { compare: { baseline: base, variants: [skilled], across: 'harness', questions: [{ question: 'Which is cleaner?', across: 'environment' }] } }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /^ {2}question 1\/1 {2}Which is cleaner\? · after the run · shows task, diff · environment · 6 pairs · fake$/m,
    )
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [answer] = readRun(p.dir).evals[0]?.answers ?? []
    assert.ok(answer)
    assert.ok(answer.votes.every((v) => v.cut === 'within'))
    assert.ok(!answer.rates.some((x) => x.cut === 'across'))
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
  analysis: { model: fakeAnalysis({ vote: { error: 'the model is over quota' } }) },
})
`,
      ...asks(`['Which is cleaner?']`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /compare question "Which is cleaner\?" on evals\/q\.eval\.ts › asks failed: the model is over quota\. Outcomes are unchanged\./,
    )
    assert.match(
      r.stdout,
      /^ {2}question {2}Which is cleaner\?\n {4}the model call failed: the model is over quota$/m,
    )
    const run = readRun(p.dir)
    const [e] = run.evals
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
  })
})
