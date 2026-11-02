import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: the README is shown as it is, not as the eval guesses it.
evaluate('canary', { environments: app }, async (c) => {
  await c.send('write the app')
  let contents: unknown
  const look = fakeJudge({
    score: (state) => {
      contents = state.contents
      return 1
    },
  })
  await c.judge('Does the README match the app?', {
    model: look,
    contents: ['README.md', 'src/app.ts', 'missing.md'],
  })
  expect(contents).toEqual({
    'README.md': 'Run npm test\n',
    'missing.md': null,
    'src/app.ts': 'export const app = () => "hello"\n',
  })
})
