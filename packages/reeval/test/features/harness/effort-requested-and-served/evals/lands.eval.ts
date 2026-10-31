import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// The turn reports the served label, which can differ from the requested effort.
evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('Reply done.')
  expect(turn.model).toBe('fake-1[effort=medium]')
})
