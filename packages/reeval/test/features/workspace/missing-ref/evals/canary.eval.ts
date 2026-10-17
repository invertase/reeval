import { evaluate, expect } from 'reeval'
import { pinned } from './env.ts'

// Must fail: a ref the repository has is fetched, and v1's greeting isn't main's.
evaluate('canary', { environment: pinned }, async (c) => {
  expect(await c.readFile('greet.js')).toContain('Ahoy')
})
