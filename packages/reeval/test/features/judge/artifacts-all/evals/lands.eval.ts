import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { ui } from './env.ts'

// artifacts: true sends every capture the attempt took, in the order it took them.
evaluate('lands', { environment: ui }, async (c) => {
  await c.send('write the form')
  const server = await c.serve('node server.mjs')
  await c.capture(server, { name: 'empty' })
  await c.capture(server, { name: 'filled' })
  let seen: unknown
  const look = fakeJudge({
    score: (state) => {
      seen = state
      return 1
    },
  })
  const verdict = await c.judge('the form shows an error after a failed submit', {
    model: look,
    artifacts: true,
  })
  const parts = seen as Array<{ type: string; mediaType?: string }>
  expect(parts.filter((p) => p.type === 'file').map((p) => p.mediaType)).toEqual([
    'image/png',
    'image/png',
  ])
  expect(verdict.artifacts?.map((a) => a.name)).toEqual(['empty', 'filled'])
})
