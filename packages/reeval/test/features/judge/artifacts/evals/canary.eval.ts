import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { ui } from './env.ts'

// Must fail: the capture is a PNG file part, not jpeg.
evaluate('canary', { environment: ui }, async (c) => {
  await c.send('write the form')
  const server = await c.serve('node server.mjs')
  const image = await c.capture(server, { name: 'form' })
  let seen: unknown
  const look = fakeJudge({
    score: (state) => {
      seen = state
      return 1
    },
  })
  await c.judge('the form shows an error after a failed submit', {
    model: look,
    artifacts: [image],
  })
  const parts = seen as Array<{ type: string; mediaType?: string }>
  expect(parts.find((p) => p.type === 'file')?.mediaType).toBe('image/jpeg')
})
