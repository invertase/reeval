import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Must fail: setup saw the v1 tag, not main.
evaluate('canary', { environment: built }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('seen-by-setup.txt')).toBe('v2\n')
})
