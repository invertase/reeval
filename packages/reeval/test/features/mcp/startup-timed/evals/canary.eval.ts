import { evaluate, expect } from 'reeval'
import { crashing, firstStartMs, prompt } from './env.ts'

// Must fail: this server exits before it answers initialize, so its start has no timing.
evaluate('canary', { environments: crashing }, async (c) => {
  await c.send(prompt)
  expect(await firstStartMs(c)).not.toBeNull()
})
