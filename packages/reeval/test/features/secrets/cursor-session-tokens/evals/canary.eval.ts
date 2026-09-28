import { evaluate, expect } from 'reeval'
import { plain, signature } from './env.ts'

// Must fail: before a turn no runner holds the key, so there's nothing to exchange.
evaluate('canary', { environment: plain }, async (t) => {
  await t.sandbox()
  expect(await signature(t.exec)).toMatch(/^reeval_secret_/)
})
