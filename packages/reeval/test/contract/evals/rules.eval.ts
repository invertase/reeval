import { evaluate, expect } from 'reeval'
import { prompts, RULES_WORD, ruled, trimmed } from './probes.ts'

// The agent reads the environment's rules (AGENTS.md or CLAUDE.md) without being told where they
// are: the codeword it writes is only in the rules.
evaluate('rules', { environment: ruled }, async (t) => {
  await t.send(prompts.rules)
  expect(await trimmed(t.readFile, 'codeword.txt')).toBe(RULES_WORD)
})

// Must fail: with no turn, nothing has written the codeword.
evaluate('rules canary', { environment: ruled }, async (t) => {
  await t.sandbox()
  expect(await trimmed(t.readFile, 'codeword.txt')).toBe(RULES_WORD)
})
