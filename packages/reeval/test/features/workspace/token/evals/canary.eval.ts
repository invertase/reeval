import { evaluate, expect } from 'reeval'
import { privateRepo } from './env.ts'

// Must fail: the v1 tag, not main, is what was fetched.
evaluate('canary', { environments: privateRepo }, async (c) => {
  expect(await c.readFile('greet.js')).toContain('Ahoy')
})
