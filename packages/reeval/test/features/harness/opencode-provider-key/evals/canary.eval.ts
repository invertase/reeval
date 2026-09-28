import { evaluate, expect } from 'evalsuite'
import { closed, keysSeen, prompt } from './env.ts'

// Must fail: the agent's shell has a second provider's key too.
evaluate('canary', { environment: closed }, async (t) => {
  await t.send(prompt)
  const keys = keysSeen(await t.readFile('keys.txt'))
  expect(keys).toHaveLength(2)
})
