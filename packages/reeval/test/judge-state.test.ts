import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeProblem } from '../src/contract/judge.ts'
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

test('state resolves every key to its default, and merges key by key', () => {
  assert.deepEqual(resolveStateOptions(undefined), {
    task: true,
    output: true,
    files: true,
    diff: true,
    contents: [],
    transcript: false,
    turns: 'last',
    checks: false,
  })
  assert.deepEqual(resolveStateOptions({}), resolveStateOptions(undefined))
  const merged = mergeJudge(
    { threshold: 0.7, state: { diff: ['src/'], transcript: 'tools' } },
    { state: { contents: ['a.md'], transcript: false } },
  )
  assert.deepEqual(merged, {
    threshold: 0.7,
    state: { diff: ['src/'], transcript: false, contents: ['a.md'] },
  })
  assert.deepEqual(mergeJudge({ threshold: 0.7 }, { threshold: 0.9 }), { threshold: 0.9 })
})

test('judge options name an unknown key, a misspelt state key and a bad value', () => {
  const loc = { at: 'options', where: 'evals/a.eval.ts › lands' } as const
  assert.equal(
    judgeProblem({ include: ['src/'] }, loc),
    'Unknown judge option "include" in evals/a.eval.ts › lands. Did you mean "state.diff"?',
  )
  assert.equal(
    judgeProblem({ thresold: 0.5 }, loc),
    'Unknown judge option "thresold" in evals/a.eval.ts › lands. Did you mean "threshold"?',
  )
  assert.equal(
    judgeProblem({ on: 'x' }, loc),
    'Unknown judge option "on" in evals/a.eval.ts › lands. on is per call: c.judge(question, { on }).',
  )
  assert.equal(judgeProblem({ on: 'x', artifacts: [] }, { at: 'call' }), undefined)
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
    'c.judge() artifacts must be a list of capture handles or names (got "form")',
  )
  assert.equal(
    judgeProblem({ model: { kind: 'fake-judge', score: () => 1 } }, { at: 'call' }),
    undefined,
  )
  assert.equal(
    judgeProblem({ state: { contnets: ['a'] } }, loc),
    'Unknown judge.state key "contnets" in evals/a.eval.ts › lands. Did you mean "contents"?',
  )
  assert.equal(
    judgeProblem({ state: { turns: 'first' } }, loc),
    `judge.state.turns must be 'last' or 'all' (got "first") in evals/a.eval.ts › lands`,
  )
  assert.equal(
    judgeProblem({ state: { diff: [] } }, loc),
    'judge.state.diff must be true, false or a non-empty list of patterns (got []) in evals/a.eval.ts › lands',
  )
  assert.equal(
    judgeProblem({ state: { contents: ['**', '!dist/'], checks: true } }, loc),
    undefined,
  )
})

const patch = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`

test("a provider error keeps the provider's message and names the state keys that were on, largest first", () => {
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
    /^The judge's input was ~7k tokens \(estimated\): diff 5k, of which big\.ts is 5k; transcript 2k\. Narrow state\.diff, state\.transcript, state\.files, state\.task or state\.output\.$/,
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
