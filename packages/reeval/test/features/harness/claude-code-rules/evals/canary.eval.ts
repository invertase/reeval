import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: Claude Code reads CLAUDE.md, so nothing is written to AGENTS.md.
evaluate('canary', { environment: houseRules }, async (c) => {
  expect(await c.readFile('AGENTS.md')).toBe('Always write tests.')
})
