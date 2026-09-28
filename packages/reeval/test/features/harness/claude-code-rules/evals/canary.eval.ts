import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: Claude Code reads CLAUDE.md, so nothing is written to AGENTS.md.
evaluate('canary', { environment: houseRules }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('AGENTS.md')).toBe('Always write tests.')
})
