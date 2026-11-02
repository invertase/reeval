import { evaluate, expect } from 'reeval'
import { staged, vendored } from './env.ts'

// Must fail: the other vendored tarball's greeting isn't what 1.2.3 holds.
evaluate('canary', { environments: vendored }, async (c) => {
  expect(await c.readFile(staged)).toContain('Hello there, <name>.')
})
