import { evaluate, expect } from 'reeval'
import { plain, prompt } from './env.ts'

// Must fail: the turn reports its tokens, so its usage isn't null.
evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.usage).toBeNull()
})
