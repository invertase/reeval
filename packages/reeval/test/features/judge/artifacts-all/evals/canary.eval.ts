import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { ui } from './env.ts'

// Must fail: artifacts: true sends the captures in the order the attempt took them.
evaluate('canary', { environments: ui }, async (c) => {
  await c.send('write the form')
  const server = await c.serve('node server.mjs')
  await c.capture(server, { name: 'empty' })
  await c.capture(server, { name: 'filled' })
  const verdict = await c.judge('the form shows an error after a failed submit', {
    model: fakeJudge({ score: 1 }),
    artifacts: true,
  })
  expect(verdict.artifacts?.map((a) => a.name)).toEqual(['filled', 'empty'])
})
