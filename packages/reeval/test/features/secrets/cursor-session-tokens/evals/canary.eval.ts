import { evaluate, expect } from 'reeval'
import { plain, signature } from './env.ts'

// Must fail: before a turn no runner holds the key, so there's nothing to exchange.
evaluate('canary', { environment: plain }, async (c) => {
  await c.sandbox()
  expect(await signature(c.exec)).toMatch(/^reeval_secret_/)
})
