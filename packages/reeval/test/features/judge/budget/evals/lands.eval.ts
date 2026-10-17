import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// A transcript over maxInputTokens loses events from the middle, marked where they were cut.
evaluate('lands', { environment: app }, async (c) => {
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
  expect(state.transcript).toMatch(/\[reeval: dropped \d+ events: over the judge's budget\]/)
})
