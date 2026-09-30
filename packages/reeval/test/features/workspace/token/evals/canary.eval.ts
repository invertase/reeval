import { evaluate, expect } from 'reeval'
import { privateRepo } from './env.ts'

// Must fail: the v1 tag, not main, is what was fetched.
evaluate('canary', { environment: privateRepo }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('greet.js')).toContain('Ahoy')
})
