import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: 'tools' leaves the reasoning out.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did the agent run the tests?', { model: look, sees: { transcript: 'tools' } })
  expect(state.transcript).toContain('thinking it over')
})
