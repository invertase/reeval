import { evaluate, expect } from 'evalsuite'
import { houseRules } from './env.ts'

// Must fail: Cursor reads AGENTS.md, so nothing is written to CLAUDE.md.
evaluate('canary', { environment: houseRules }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('CLAUDE.md')).toBe('Always write tests.')
})
