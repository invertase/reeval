import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// transcript: 'tools' shows the tool calls as text lines, with their output.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('write the app')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did the agent run the tests?', { model: look, sees: { transcript: 'tools' } })
  expect(state.transcript).toMatch(/^tool shell: npm test → ok.*\n  14 passing$/m)
})
