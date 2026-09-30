import { evaluate, expect } from 'reeval'
import { built } from './env.ts'

// Setup steps run in the workspace after the repository is copied in.
evaluate('lands', { environment: built }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('seen-by-setup.txt')).toBe('v1\n')
})
