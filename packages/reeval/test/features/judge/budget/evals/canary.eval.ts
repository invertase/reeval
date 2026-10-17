import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: 40 steps don't fit in 300 tokens, so some are cut.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('run the steps')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did the agent run every step?', {
    model: look,
    maxInputTokens: 300,
    sees: { transcript: true, files: false, diff: false },
  })
  expect(state.transcript).not.toMatch(/\[reeval: dropped \d+ events: over the judge's budget\]/)
})
