import { evaluate, expect } from 'reeval'
import { KEY, plain } from './env.ts'

// The case's key names the eval, which is recorded and shown masked; the body gets the case as is.
evaluate.each([{ key: KEY }])('lands [$key]', { environment: plain }, async (_c, { key }) => {
  expect(key, 'gets the case as written').toBe(KEY)
})
