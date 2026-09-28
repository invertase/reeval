import { evaluate, expect } from 'evalsuite'
import { app } from './env.ts'

// Must fail: main's newer greeting isn't what the v1 tag holds.
evaluate('canary', { environment: app }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain("'Ahoy'")
})
