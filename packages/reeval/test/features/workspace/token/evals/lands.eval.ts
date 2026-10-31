import { evaluate, expect } from 'reeval'
import { privateRepo } from './env.ts'

// The token fetched the repository on the host; the sandbox has the tree and not the token.
evaluate('lands', { environments: privateRepo }, async (c) => {
  expect(await c.readFile('greet.js')).toContain('Hello')
})
