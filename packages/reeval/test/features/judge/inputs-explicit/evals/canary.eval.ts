import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: nothing adds the task, the changed files or the diff to an output-only call.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Is the summary clear?', { model: look, output: true })
  expect(Object.keys(state)).toEqual(['task', 'output', 'files', 'diff'])
})
