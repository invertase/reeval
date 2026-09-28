import { evaluate, expect } from 'evalsuite'
import { plain, prompt } from './env.ts'

// Every turn reports its tokens: the prompt (most of it cached, from the second call on) and
// the reply.
evaluate('lands', { environment: plain }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.status).toBe('completed')
  expect(turn.usage).not.toBeNull()
  expect(turn.usage?.input).toBeGreaterThan(0)
  expect(turn.usage?.output).toBeGreaterThan(0)
  const again = await t.send(prompt)
  expect(again.usage?.input).toBeGreaterThan(0)
})
