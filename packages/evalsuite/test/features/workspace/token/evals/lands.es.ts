import { evaluate, expect } from 'evalsuite'
import { privateRepo } from './env.ts'

// The token fetched the repository on the host; the sandbox has the tree and not the token.
evaluate('lands', { environment: privateRepo }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain('Hello')
})
