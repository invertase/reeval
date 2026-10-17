import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: big.txt is over the budget, so its text is cut.
evaluate('canary', { environment: app }, async (c) => {
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
  expect(state.contents).toHaveProperty('big.txt', `${'word '.repeat(1000)}\n`)
})
