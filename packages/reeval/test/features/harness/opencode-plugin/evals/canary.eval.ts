import { evaluate, expect } from 'reeval'
import { house, trimmed } from './env.ts'

// Must fail: the review code is written by the agent following the unpacked subagent, not by
// reeval.
evaluate('canary', { environments: house }, async (c) => {
  expect(await trimmed(c.readFile, 'review.txt')).toBe('HERON-62')
})
