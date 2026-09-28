import { evaluate, expect } from 'evalsuite'
import { built } from './env.ts'

// Must fail: setup saw the v1 tag, not main.
evaluate('canary', { environment: built }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('seen-by-setup.txt')).toBe('v2\n')
})
