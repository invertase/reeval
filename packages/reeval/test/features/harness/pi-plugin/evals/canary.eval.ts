import { evaluate, expect } from 'reeval'
import { house, trimmed } from './env.ts'

// Must fail: the release code is written by the agent following the unpacked command, not by
// reeval.
evaluate('canary', { environment: house }, async (c) => {
  expect(await trimmed(c.readFile, 'release.txt')).toBe('KESTREL-19')
})
