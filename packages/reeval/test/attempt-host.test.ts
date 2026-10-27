// The attempt host's `judge` call: a wire `JudgeOn` reaches `c.judge` as the turn or the value it
// names, as a TypeScript eval passes `on`, and a turn the attempt doesn't have is a usage error.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttemptRequest } from '../src/contract/attempt.ts'
import { replyToAttempt } from '../src/language-runner/attempt-host.ts'
import type { AttemptContext, JudgeCallOptions, Turn } from '../src/types.ts'

const verdict = { verdict: 'pass', score: 1, threshold: 0.8, question: 'q', model: 'fake' }

function attempt(turns: Turn[]) {
  const asked: (JudgeCallOptions | undefined)[] = []
  const c = {
    turns,
    judge: async (_question: string, options?: JudgeCallOptions) => {
      asked.push(options)
      return verdict
    },
  } as unknown as AttemptContext
  const judge = (options?: Record<string, unknown>) =>
    replyToAttempt(c, [], new Map(), {
      id: '1',
      call: { op: 'judge', question: 'q', ...(options ? { options } : {}) },
    } as AttemptRequest)
  return { asked, judge }
}

const first = { prompt: 'one', text: 'One.' } as Turn
const second = { prompt: 'two', text: 'Two.' } as Turn

test('judge on a value grades the value itself', async () => {
  const { asked, judge } = attempt([first])
  for (const value of ['Hello, Ada!', null, { exitCode: 0, stdout: 'ok' }, [1, 2]]) {
    assert.deepEqual(await judge({ on: { value }, threshold: 0.5 }), {
      id: '1',
      ok: true,
      op: 'judge',
      verdict,
    })
    assert.deepEqual(asked.pop(), { on: value, threshold: 0.5 })
  }
})

test('judge on a turn grades that turn of the attempt', async () => {
  const { asked, judge } = attempt([first, second])
  await judge({ on: { turn: 0 } })
  assert.equal(asked.pop()?.on, first)
  await judge()
  assert.deepEqual(asked.pop(), {})
})

test("judge on a turn the attempt doesn't have is a usage error", async () => {
  const { asked, judge } = attempt([first])
  assert.deepEqual(await judge({ on: { turn: 1 } }), {
    id: '1',
    ok: false,
    op: 'judge',
    error: { name: 'UsageError', message: "c.judge()'s on is turn 1, but the attempt has 1 turn" },
  })
  assert.equal(asked.length, 0, 'the judge never ran')
  const none = attempt([])
  assert.equal(
    ((await none.judge({ on: { turn: 0 } })) as { error: { message: string } }).error.message,
    "c.judge()'s on is turn 0, but the attempt has 0 turns",
  )
})
