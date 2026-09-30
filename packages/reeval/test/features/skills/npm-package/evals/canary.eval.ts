import { evaluate, expect } from 'reeval'
import { pinned, staged } from './env.ts'

// Must fail: the latest version's greeting isn't what 1.2.3 holds.
evaluate('canary', { environment: pinned }, async (c) => {
  await c.sandbox()
  expect(await c.readFile(staged)).toContain('Hello there, <name>.')
})
