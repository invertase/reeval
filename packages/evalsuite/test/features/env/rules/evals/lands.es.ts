import { evaluate, expect } from 'evalsuite'
import { houseRules } from './env.ts'

// `rules` become the workspace's AGENTS.md, word for word.
evaluate('lands', { environment: houseRules }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('AGENTS.md')).toBe('Always write tests.')
})
