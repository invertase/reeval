import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { ui } from './env.ts'

// The judge's decide state is a JSON part plus the capture as a file part.
evaluate('lands', { environment: ui }, async (c) => {
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
  const verdict = await c.judge('the form shows an error after a failed submit', {
    model: look,
    artifacts: [image],
  })
  expect(Array.isArray(seen)).toBe(true)
  const parts = seen as Array<{ type: string; mediaType?: string; data?: Uint8Array }>
  const file = parts.find((p) => p.type === 'file')
  expect(file?.mediaType).toBe('image/png')
  expect(file?.data instanceof Uint8Array && file.data.byteLength > 0).toBe(true)
  expect(verdict.artifacts?.[0]?.name).toBe('form')
})
