import { evaluate, expect } from 'reeval'
import { closed, keysSeen, prompt } from './env.ts'

// Must fail: the agent's shell has a second provider's key too.
evaluate('canary', { environments: closed }, async (c) => {
  await c.send(prompt)
  const keys = keysSeen(await c.readFile('keys.txt'))
  expect(keys).toHaveLength(2)
})
