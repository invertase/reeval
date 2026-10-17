import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// checks: [command] shows only that command's results, as c.exec ran it.
evaluate('lands', { environment: app }, async (c) => {
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
  expect(state.checks).toEqual([
    { command: 'echo second', exitCode: 0, stdout: 'second\n', stderr: '' },
  ])
})
