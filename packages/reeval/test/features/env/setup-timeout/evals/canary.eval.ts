import { evaluate, expect } from 'reeval'
import { quick } from './env.ts'

// Must fail: a step that finishes within its timeout isn't cut off.
evaluate('canary', { environments: quick }, async (c) => {
  expect(await c.readFile('slept')).toBeNull()
})
