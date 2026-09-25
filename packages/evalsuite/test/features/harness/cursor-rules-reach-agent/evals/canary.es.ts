import { evaluate, expect } from 'evalsuite'
import { noRules, prompt } from './env.ts'

// Must fail: without the rules, the agent can't know the word.
evaluate('canary', { environment: noRules }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.text).toContain('MARMALADE')
})
