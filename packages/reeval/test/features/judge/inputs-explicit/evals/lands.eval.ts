import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// The judge is shown only the inputs the call turns on: output alone here, with no task, files or
// diff from anywhere else.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Is the summary clear?', { model: look, output: true })
  expect(Object.keys(state)).toEqual(['output'])
})
