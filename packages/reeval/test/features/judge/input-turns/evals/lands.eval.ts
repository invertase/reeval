import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// turns: 'all' puts every turn up to the graded one under turns, oldest first.
evaluate('lands', { environments: app }, async (c) => {
  await c.send('write the app')
  await c.send('now add tests')
  let state: Record<string, unknown> = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as Record<string, unknown>
      return 1
    },
  })
  await c.judge('Did the agent keep the app from turn 1?', {
    model: look,
    task: true,
    turns: 'all',
  })
  const turns = state.turns as Array<{ task: string }>
  expect(turns.map((t) => t.task)).toEqual(['write the app', 'now add tests'])
})
