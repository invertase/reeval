import { evaluate, expect } from 'reeval'
import { noRules, prompt } from './env.ts'

// Must fail: without the rules, the agent can't know the word.
evaluate('canary', { environments: noRules }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.text).toContain('MARMALADE')
})
