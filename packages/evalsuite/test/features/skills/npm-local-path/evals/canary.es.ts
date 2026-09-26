import { evaluate, expect } from 'evalsuite'
import { staged, vendored } from './env.ts'

// Must fail: the other vendored tarball's greeting isn't what 1.2.3 holds.
evaluate('canary', { environment: vendored }, async (t) => {
  await t.sandbox()
  expect(await t.readFile(staged)).toContain('Hello there, <name>.')
})
