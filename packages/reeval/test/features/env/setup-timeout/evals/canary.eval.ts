import { evaluate, expect } from 'reeval'
import { quick } from './env.ts'

// Must fail: a step that finishes within its timeout isn't cut off.
evaluate('canary', { environment: quick }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('slept')).toBeNull()
})
