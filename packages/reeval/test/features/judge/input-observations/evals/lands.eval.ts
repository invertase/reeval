import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// observations: [name] shows only that name's value, by name.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('write the app')
  c.observe('orm', 'drizzle')
  c.observe('files', 1)
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did it pick drizzle?', { model: look, observations: ['orm'] })
  expect(state.observations).toEqual({ orm: 'drizzle' })
})
