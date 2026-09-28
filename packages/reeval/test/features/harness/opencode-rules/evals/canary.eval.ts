import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: OpenCode reads AGENTS.md, so nothing is written to Claude Code's CLAUDE.md.
evaluate('canary', { environment: houseRules }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('CLAUDE.md')).toBe('Always write tests.')
})
