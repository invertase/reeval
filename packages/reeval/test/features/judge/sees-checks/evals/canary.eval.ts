import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// Must fail: the first command isn't listed, so the judge doesn't see it.
evaluate('canary', { environment: app }, async (c) => {
  await c.send('write the app')
  await c.exec('echo first')
  await c.exec('echo second')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did the second check pass?', { model: look, sees: { checks: ['echo second'] } })
  expect(state.checks).toEqual([{ command: 'echo first', exitCode: 0, stdout: 'first\n', stderr: '' }])
})
