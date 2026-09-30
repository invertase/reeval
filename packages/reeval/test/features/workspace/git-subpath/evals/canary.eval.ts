import { evaluate, expect } from 'reeval'
import { app } from './env.ts'

// Must fail: main's newer greeting isn't what the v1 tag holds.
evaluate('canary', { environment: app }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('greet.js')).toContain("'Ahoy'")
})
