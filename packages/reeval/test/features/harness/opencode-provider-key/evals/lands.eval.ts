import { evaluate, expect } from 'reeval'
import { closed, keysSeen, prompt } from './env.ts'

// The agent's shell has the model's provider's key, as a placeholder, and no other provider's.
evaluate('lands', { environment: closed }, async (t) => {
  await t.send(prompt)
  const keys = keysSeen(await t.readFile('keys.txt'))
  expect(keys).toEqual([expect.stringMatching(/^aisdkhc_[\w-]{43}$/)])
})
