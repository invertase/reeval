import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeProblem, NO_JUDGE_INPUT } from '../src/contract/judge.ts'
import { withInputSize } from '../src/judge/size.ts'
import { type Draft, stateOf } from '../src/judge/state.ts'
import { mergeJudge, resolveStateOptions } from '../src/judge/state-options.ts'
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
    type: 'file-edit',
    toolCallId: 't5',
    path: 'notes.txt',
    kind: 'write',
    added: 2,
    removed: null,
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
      'edit notes.txt (write, +2)',
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

test("a call's inputs resolve every key, off unless it turns it on", () => {
  assert.deepEqual(resolveStateOptions({ contents: ['src/**'] }), {
    task: false,
    output: false,
    files: false,
    diff: false,
    contents: ['src/**'],
    transcript: false,
    turns: 'last',
    checks: false,
  })
  assert.deepEqual(resolveStateOptions({ diff: true, turns: 'all' }).turns, 'all')
  assert.deepEqual(mergeJudge({ threshold: 0.7 }, { threshold: 0.9 }), { threshold: 0.9 })
  assert.deepEqual(mergeJudge({ threshold: 0.7, model: 'google/g' }, { model: 'openai/o' }), {
    threshold: 0.7,
    model: 'openai/o',
  })
})

test('judge options keep the inputs to the call, and a call names at least one', () => {
  const loc = { at: 'options', where: 'evals/a.eval.ts › lands' } as const
  assert.equal(
    judgeProblem({ diff: ['src/'] }, loc),
    'Unknown judge option "diff" in evals/a.eval.ts › lands. diff is per call: c.judge(question, { diff }).',
  )
  assert.equal(
    judgeProblem({ thresold: 0.5 }, loc),
    'Unknown judge option "thresold" in evals/a.eval.ts › lands. Did you mean "threshold"?',
  )
  assert.equal(
    judgeProblem({ on: 'x' }, loc),
    'Unknown judge option "on" in evals/a.eval.ts › lands. on is per call: c.judge(question, { on }).',
  )
  assert.equal(
    judgeProblem({ state: { diff: true } }, loc),
    'Unknown judge option "state" in evals/a.eval.ts › lands.',
  )
  assert.equal(judgeProblem({ output: true, on: 'x', artifacts: [] }, { at: 'call' }), undefined)
  assert.equal(judgeProblem({ on: 'x', artifacts: [] }, { at: 'call' }), NO_JUDGE_INPUT)
  assert.equal(judgeProblem({}, { at: 'call' }), NO_JUDGE_INPUT)
  assert.equal(judgeProblem({ threshold: 0.5, diff: false }, { at: 'call' }), NO_JUDGE_INPUT)
  assert.equal(
    judgeProblem({ threshold: 2, maxConcurrent: 0 }, { at: 'call' }),
    'c.judge() threshold must be between 0 and 1 (got 2)',
  )
  assert.equal(
    judgeProblem({ maxConcurrent: 0 }, { at: 'call' }),
    'c.judge() maxConcurrent must be a whole number of at least 1 (got 0)',
  )
  assert.equal(
    judgeProblem({ artifacts: 'form' }, { at: 'call' }),
    'c.judge() artifacts must be true or a list of capture handles or names (got "form")',
  )
  assert.equal(
    judgeProblem({ model: { kind: 'fake-judge', score: () => 1 }, task: true }, { at: 'call' }),
    undefined,
  )
  assert.equal(
    judgeProblem({ contnets: ['a'] }, { at: 'call' }),
    'Unknown judge option "contnets" in c.judge(). Did you mean "contents"?',
  )
  assert.equal(
    judgeProblem({ diff: true, turns: 'first' }, { at: 'call' }),
    `c.judge() turns must be 'last' or 'all' (got "first")`,
  )
  assert.equal(
    judgeProblem({ diff: [] }, { at: 'call' }),
    'c.judge() diff must be true, false or a non-empty list of patterns (got [])',
  )
  assert.equal(
    judgeProblem({ contents: ['**', '!dist/'], checks: true }, { at: 'call' }),
    undefined,
  )
})

const patch = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`

test("a provider error keeps the provider's message and names the inputs that were on, largest first", () => {
  const state = stateOf({
    all: false,
    turns: [{ task: 'do it', output: 'done', transcript: 't'.repeat(8000) }],
    files: ['added big.ts'],
    diff: patch('big.ts', 'b'.repeat(20_000)),
  })
  const message = withInputSize('{"error_type":"max_tokens_exceeded"}', state, 'ok?')
  const [provider, hint, ...rest] = message.split('\n')
  assert.equal(provider, '{"error_type":"max_tokens_exceeded"}')
  assert.deepEqual(rest, [])
  assert.match(
    hint ?? '',
    /^The judge's input was ~7k tokens \(estimated\): diff 5k, of which big\.ts is 5k; transcript 2k\. Narrow diff, transcript, files, task or output\.$/,
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
