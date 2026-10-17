import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Patterns expand over the files git sees, in path order: the tests and the gitignored file
// are out, and docs/** matches nothing, so it adds nothing.
evaluate('lands', { environment: app }, async (c) => {
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
  expect(Object.keys(state.contents as object)).toEqual(['src/app.ts', 'src/util.ts'])
})
