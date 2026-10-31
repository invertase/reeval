import { evaluate, expect } from 'reeval'
import { KEY, plain } from './env.ts'

// The case's key names the eval, which is recorded and shown masked; the body gets the case as is.
evaluate('lands', { environments: plain, cases: [{ id: KEY }] }, async (_c, { id }) => {
  expect(id, 'gets the case as written').toBe(KEY)
})
