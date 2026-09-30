import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: the `!*.test.ts` pattern leaves the test file out.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let files: unknown
  const look = fakeJudge({
    score: (state) => {
      files = state.files
      return 1
    },
  })
  await c.judge('Did the agent write the app?', { model: look, include: ['src/', '!*.test.ts'] })
  expect(files).toEqual(['added src/app.test.ts', 'added src/app.ts'])
})
