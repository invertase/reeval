import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// include narrows the judge to src/, and a later `!` pattern takes the tests back out.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('write the app')
  let files: unknown
  const look = fakeJudge({
    score: (state) => {
      files = state.files
      return 1
    },
  })
  await c.judge('Did the agent write the app?', { model: look, include: ['src/', '!*.test.ts'] })
  expect(files).toEqual(['added src/app.ts'])
})
