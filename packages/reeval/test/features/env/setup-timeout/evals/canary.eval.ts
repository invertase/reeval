import { evaluate, expect } from 'reeval'
import { quick } from './env.ts'

// Must fail: a step that finishes within its timeout isn't cut off.
evaluate('canary', { environment: quick }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('slept')).toBeNull()
})
