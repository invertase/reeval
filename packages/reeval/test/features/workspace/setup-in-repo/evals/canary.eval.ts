import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Must fail: setup saw the v1 tag, not main.
evaluate('canary', { environments: built }, async (c) => {
  expect(await c.readFile('seen-by-setup.txt')).toBe('v2\n')
})
