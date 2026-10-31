import { evaluate, expect } from 'reeval'
import { house, trimmed } from './env.ts'

// Must fail: the codeword is written by the agent following the unpacked rule, not by reeval.
evaluate('canary', { environments: house }, async (c) => {
  expect(await trimmed(c.readFile, 'codeword.txt')).toBe('SAFFRON-73')
})
