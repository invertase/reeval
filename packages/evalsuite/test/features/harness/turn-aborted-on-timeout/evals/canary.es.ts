import { evaluate, expect } from 'evalsuite'
import { plain } from './env.ts'

// Must fail: with no turn, there's no aborted turn to find.
evaluate('canary', { environment: plain, timeout: '4s' }, async (t) => {
  await t.sandbox()
  expect(t.turns.at(0)?.status).toBe('aborted')
})
