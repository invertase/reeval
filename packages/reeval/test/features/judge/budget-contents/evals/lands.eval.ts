import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// contents: ['**'] takes every file; over the budget, the largest is cut and the small ones stay.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('write the notes')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Are the notes consistent?', {
    model: look,
    maxInputTokens: 300,
    sees: { contents: ['**'], files: false, diff: false },
  })
  expect(state.contents).toEqual({
    'a.txt': 'small a\n',
    'b.txt': 'small b\n',
    'big.txt': "[reeval: dropped: ~1k tokens, over the judge's budget]",
  })
})
