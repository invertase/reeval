import { evaluate, expect } from 'reeval'
import { app } from './env.ts'

// The workspace is app/'s contents at the v1 tag, not at the branch head.
evaluate('lands', { environment: app }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain("'Hello'")
})
