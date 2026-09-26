import { evaluate, expect } from 'evalsuite'
import { plain, prompt } from './env.ts'

// Must fail: the turn reports its tokens, so its usage isn't null.
evaluate('canary', { environment: plain }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.usage).toBeNull()
})
