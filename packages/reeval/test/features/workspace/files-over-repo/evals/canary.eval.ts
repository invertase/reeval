import { evaluate, expect } from 'reeval'
import { patched } from './env.ts'

// Must fail: the repository's own greet.js was replaced.
evaluate('canary', { environment: patched }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain('Hello')
})
