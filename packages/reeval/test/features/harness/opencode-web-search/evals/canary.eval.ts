import { evaluate, expect } from 'evalsuite'
import { closed, prompt } from './env.ts'

// Must fail: the agent searched the web.
evaluate('canary', { environment: closed }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn).not.toHaveSearched()
})
