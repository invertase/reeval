import { evaluate, expect } from 'reeval'
import { closed, prompt } from './env.ts'

// Must fail: the agent searched the web.
evaluate('canary', { environments: closed }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn).not.toHaveSearched()
})
