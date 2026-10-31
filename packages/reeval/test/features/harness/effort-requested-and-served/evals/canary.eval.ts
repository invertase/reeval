import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: the served label is medium, not the requested high.
evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('Reply done.')
  expect(turn.model).toBe('fake-1[effort=high]')
})
