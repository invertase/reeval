import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: Cursor reads AGENTS.md, so nothing is written to CLAUDE.md.
evaluate('canary', { environment: houseRules }, async (c) => {
  expect(await c.readFile('CLAUDE.md')).toBe('Always write tests.')
})
