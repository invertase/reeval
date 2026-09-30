import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: Claude Code reads CLAUDE.md, so nothing is written to AGENTS.md.
evaluate('canary', { environment: houseRules }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('AGENTS.md')).toBe('Always write tests.')
})
