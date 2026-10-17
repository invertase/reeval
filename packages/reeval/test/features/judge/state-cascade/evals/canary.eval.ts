import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: the call keeps the config's diff patterns, so notes.md isn't a changed file.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Do the notes match the app?', { model: look, state: { contents: ['notes.md'] } })
  expect({ files: state.files, contents: Object.keys(state.contents as object) }).toEqual({
    files: ['added notes.md', 'added src/app.ts'],
    contents: ['notes.md'],
  })
})
