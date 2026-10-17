import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type Draft,
  draftTranscript,
  fitBudget,
  stateBudget,
  stateOf,
} from '../src/judge/budget.ts'
import { judgeProblem, mergeJudge, resolveSees } from '../src/judge/sees.ts'
import { transcriptForJudge } from '../src/judge/transcript.ts'
import type { TranscriptEvent } from '../src/types.ts'

const at = { at: '2026-10-17T00:00:00.000Z' } as const
const events = [
  { ...at, type: 'text', text: 'Looking at the tests.', durationMs: null },
  { ...at, type: 'reasoning', text: 'They probably use node:test.', durationMs: null },
  {
    ...at,
    type: 'tool',
    toolCallId: 't1',
    tool: 'shell',
    input: { command: 'npm test' },
    output: `14 passing\n${'x'.repeat(400)}`,
    ok: true,
    durationMs: 2100,
  },
  {
    ...at,
    type: 'file-edit',
    toolCallId: 't2',
    path: 'src/auth.ts',
    kind: 'modify',
    added: 31,
    removed: 4,
    durationMs: null,
  },
  {
    ...at,
    type: 'web-fetch',
    toolCallId: 't3',
    url: 'https://example.com/a',
    ok: false,
    durationMs: null,
  },
  {
    ...at,
    type: 'web-search',
    toolCallId: 't4',
    query: 'firebase auth',
    references: 3,
    durationMs: null,
  },
  { ...at, type: 'error', message: 'rate limited' },
] as unknown as TranscriptEvent[]

test('the transcript renders one compact entry per event, by mode', () => {
  const tools = transcriptForJudge(events, 'tools')
  assert.deepEqual(
    tools.map((l) => l.split('\n')[0]),
    [
      'tool shell: npm test → ok · 2s',
      'edit src/auth.ts (modify, +31 −4)',
      'fetch https://example.com/a → failed',
      'search "firebase auth" → ok',
      'error: rate limited',
    ],
  )
  assert.ok((tools[0]?.length ?? 0) < 340, 'tool output is clipped')
  const messages = transcriptForJudge(events, true)
  assert.equal(messages[0], 'message: Looking at the tests.')
  assert.ok(!messages.some((l) => l.startsWith('reasoning:')), 'no reasoning without full')
  const full = transcriptForJudge(events, 'full')
  assert.equal(full[1], 'reasoning: They probably use node:test.')
  assert.ok(full[2]?.includes('x'.repeat(400)), 'full leaves tool output whole')
})

test('sees resolves every key to its default, and merges key by key', () => {
  assert.deepEqual(resolveSees(undefined), {
    task: true,
    output: true,
    files: true,
    diff: true,
    contents: [],
    transcript: false,
    turns: 'last',
    checks: false,
  })
  assert.deepEqual(resolveSees({}), resolveSees(undefined))
  const merged = mergeJudge(
    { threshold: 0.7, sees: { diff: ['src/'], transcript: 'tools' } },
    { sees: { contents: ['a.md'], transcript: false } },
  )
  assert.deepEqual(merged, {
    threshold: 0.7,
    sees: { diff: ['src/'], transcript: false, contents: ['a.md'] },
  })
  assert.deepEqual(mergeJudge({ threshold: 0.7 }, { threshold: 0.9 }), { threshold: 0.9 })
})

test('judge options name an unknown key, a misspelt sees key and a bad value', () => {
  const loc = ' in evals/a.eval.ts › lands'
  assert.equal(
    judgeProblem({ include: ['src/'] }, loc),
    'Unknown judge option "include" in evals/a.eval.ts › lands. Did you mean "sees.diff"?',
  )
  assert.equal(
    judgeProblem({ thresold: 0.5 }, loc),
    'Unknown judge option "thresold" in evals/a.eval.ts › lands. Did you mean "threshold"?',
  )
  assert.equal(
    judgeProblem({ on: 'x' }, loc),
    'Unknown judge option "on" in evals/a.eval.ts › lands. on is per call: c.judge(question, { on }).',
  )
  assert.equal(judgeProblem({ on: 'x', artifacts: [] }, loc, true), undefined)
  assert.equal(
    judgeProblem({ sees: { contnets: ['a'] } }, loc),
    'Unknown judge.sees key "contnets" in evals/a.eval.ts › lands. Did you mean "contents"?',
  )
  assert.equal(
    judgeProblem({ sees: { turns: 'first' } }, loc),
    `judge.sees.turns must be 'last' or 'all' (got "first") in evals/a.eval.ts › lands`,
  )
  assert.equal(
    judgeProblem({ sees: { diff: [] } }, loc),
    'judge.sees.diff must be true, false or a non-empty list of patterns (got []) in evals/a.eval.ts › lands',
  )
  assert.equal(judgeProblem({ sees: { contents: ['**', '!dist/'], checks: true } }, loc), undefined)
})

test('each model has its state budget, maxInputTokens overrides it, and a fake judge has none', () => {
  assert.equal(stateBudget('typesafe-ai/jev-1.13.0'), 32_000)
  assert.equal(stateBudget('google/gemini-3.8-flash'), 100_000)
  assert.equal(stateBudget('fake'), undefined)
  assert.equal(stateBudget('fake', 500), 500)
  assert.equal(stateBudget('typesafe-ai/jev-1.13.0', 8000), 8000)
})

const patch = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`

test('the budget cuts the transcript first, then the largest diff files, and names each cut', () => {
  const draft: Draft = {
    all: false,
    turns: [
      {
        task: 'do it',
        output: 'done',
        transcript: draftTranscript(
          Array.from({ length: 30 }, (_, i) => ({
            ...events[2],
            toolCallId: `t${i}`,
          })) as TranscriptEvent[],
          'full',
        ),
      },
    ],
    files: ['added big.ts', 'added small.ts'],
    diff: patch('big.ts', 'b'.repeat(6000)) + patch('small.ts', 'small'),
  }
  const fit = fitBudget(draft, 'ok?', 400, 'fake')
  assert.ok('dropped' in fit)
  assert.deepEqual(fit.dropped, [
    "transcript: tool input and output clipped, over the judge's budget of 400 tokens",
    `transcript: ${draft.turns[0]?.transcript?.omitted} events, over the judge's budget of 400 tokens`,
    "big.ts: over the judge's budget of 400 tokens",
  ])
  const state = stateOf(draft)
  assert.match(String(state.diff), /\[reeval: dropped big\.ts: over the judge's budget\]/)
  assert.match(String(state.diff), /\+small/, 'the smaller file stays')
  assert.match(String(state.transcript), /\[reeval: dropped \d+ events: over the judge's budget\]/)
  assert.ok(JSON.stringify(state).length / 4 <= 400)
})

test('a state whose kept parts alone are over the budget is an error naming them', () => {
  const draft: Draft = { all: false, turns: [{ task: 't'.repeat(8000), output: 'done' }] }
  const fit = fitBudget(draft, 'ok?', 1000, 'typesafe-ai/jev-1.13.0')
  assert.ok('error' in fit)
  assert.match(
    fit.error,
    /^The judge's input is ~2k tokens \(estimated\) after every cut, over typesafe-ai\/jev-1\.13\.0's budget of 1k: task 2k\. Leave a part out with sees/,
  )
})

test("turns: 'all' puts each turn under turns; the graded turn's keys are at the top otherwise", () => {
  const two: Draft = {
    all: true,
    turns: [
      { task: 'one', output: 'a' },
      { task: 'two', output: 'b' },
    ],
    files: [],
  }
  assert.deepEqual(stateOf(two), {
    turns: [
      { task: 'one', output: 'a' },
      { task: 'two', output: 'b' },
    ],
    files: [],
  })
  assert.deepEqual(Object.keys(stateOf({ ...two, all: false })), ['task', 'output', 'files'])
})
