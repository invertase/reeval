import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: the `!**/*.test.ts` pattern leaves the test file out.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Is the app tidy?', {
    model: look,
    sees: { contents: ['src/**', '!**/*.test.ts', 'docs/**'] },
  })
  expect(Object.keys(state.contents as object)).toEqual(['src/app.test.ts', 'src/app.ts', 'src/util.ts'])
})
