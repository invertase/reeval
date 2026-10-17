import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Setup steps run in the workspace after the repository is copied in.
evaluate('lands', { environment: built }, async (c) => {
  expect(await c.readFile('seen-by-setup.txt')).toBe('v1\n')
})
