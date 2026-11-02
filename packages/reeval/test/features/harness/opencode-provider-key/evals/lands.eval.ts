import { evaluate, expect } from 'reeval'
import { closed, keysSeen, prompt } from './env.ts'

// The agent's shell has the model's provider's key, as a placeholder, and no other provider's.
evaluate('lands', { environments: closed }, async (c) => {
  await c.send(prompt)
  const keys = keysSeen(await c.readFile('keys.txt'))
  expect(keys).toEqual([expect.stringMatching(/^aisdkhc_[\w-]{43}$/)])
})
