import { evaluate, expect } from 'evalsuite'
import { built } from './env.ts'

// Setup steps run in the workspace after the repository is copied in.
evaluate('lands', { environment: built }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('seen-by-setup.txt')).toBe('v1\n')
})
