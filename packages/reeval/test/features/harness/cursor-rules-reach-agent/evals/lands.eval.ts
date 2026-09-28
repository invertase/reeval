import { evaluate, expect } from 'reeval'
import { houseRules, prompt } from './env.ts'

// Cursor loads the environment's rules (AGENTS.md) into its context without being told to read it.
evaluate('lands', { environment: houseRules }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.text).toContain('MARMALADE')
})
