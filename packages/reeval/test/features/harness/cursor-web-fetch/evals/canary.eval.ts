import { evaluate, expect } from 'reeval'
import { beacon, plain, prompt } from './env.ts'

// Must fail: the agent fetched the page, so its reply has the beacon's round and randomness.
evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.text).not.toMatch(beacon)
})
