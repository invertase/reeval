import { evaluate, expect } from 'evalsuite'
import { privateRepo } from './env.ts'

// Must fail: the v1 tag, not main, is what was fetched.
evaluate('canary', { environment: privateRepo }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain('Ahoy')
})
