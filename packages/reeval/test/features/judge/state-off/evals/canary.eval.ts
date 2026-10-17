import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: diff: false leaves the diff out.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Is the summary clear?', {
    model: look,
    state: { task: false, files: false, diff: false },
  })
  expect(Object.keys(state)).toEqual(['output', 'diff'])
})
