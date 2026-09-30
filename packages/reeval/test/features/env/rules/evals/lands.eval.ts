import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// `rules` become the workspace's AGENTS.md, word for word.
evaluate('lands', { environment: houseRules }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('AGENTS.md')).toBe('Always write tests.')
})
