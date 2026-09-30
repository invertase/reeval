import { evaluate, expect } from 'reeval'
import { patched } from './env.ts'

// Must fail: the repository's own greet.js was replaced.
evaluate('canary', { environment: patched }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('greet.js')).toContain('Hello')
})
