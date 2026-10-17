import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: rules go to AGENTS.md, not Claude's CLAUDE.md.
evaluate('canary', { environment: houseRules }, async (c) => {
  expect(await c.readFile('CLAUDE.md')).toBe('Always write tests.')
})
