import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: a turn that ends inside the timeout was never cut off.
evaluate('canary', { environments: plain, timeout: '60s' }, async (c) => {
  await c.send('Run `echo step-1`, write notes.txt, then wait.')
  expect(c.turns.at(0)?.status).toBe('aborted')
})
