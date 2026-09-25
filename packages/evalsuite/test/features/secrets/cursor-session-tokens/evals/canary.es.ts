import { evaluate, expect } from 'evalsuite'
import { plain, signature } from './env.ts'

// Must fail: before a turn, the CLI hasn't exchanged its key, so it has no token at all.
evaluate('canary', { environment: plain }, async (t) => {
  await t.sandbox()
  expect(await signature(t.readFile)).toMatch(/^es_secret_/)
})
