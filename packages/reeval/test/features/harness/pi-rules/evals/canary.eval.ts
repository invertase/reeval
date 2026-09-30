import { evaluate, expect } from 'reeval'
import { houseRules } from './env.ts'

// Must fail: pi reads AGENTS.md, so nothing is written to Claude Code's CLAUDE.md.
evaluate('canary', { environment: houseRules }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('CLAUDE.md')).toBe('Always write tests.')
})
