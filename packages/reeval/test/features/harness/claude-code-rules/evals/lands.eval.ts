import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Under Claude Code, `rules` become the workspace's CLAUDE.md, word for word.
evaluate('lands', { environment: houseRules }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('CLAUDE.md')).toBe('Always write tests.')
})
