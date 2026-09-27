import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// Must fail: a turn that ends inside the timeout is completed, not aborted.
evaluate('canary', { environment: plain, timeout: '60s' }, async (t) => {
  await t.send('Reply with the word done.')
  expect(t.turns.at(0)?.status).toBe('aborted')
})
