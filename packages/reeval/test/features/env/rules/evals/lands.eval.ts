import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// `rules` become the workspace's AGENTS.md, word for word.
evaluate('lands', { environment: houseRules }, async (c) => {
  expect(await c.readFile('AGENTS.md')).toBe('Always write tests.')
})
