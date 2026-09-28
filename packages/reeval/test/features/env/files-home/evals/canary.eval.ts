import { evaluate, expect } from 'evalsuite'
import { homeFiles } from './env.ts'

// Must fail: a `~/` file isn't written into the workspace.
evaluate('canary', { environment: homeFiles }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('.config/es/hint.txt')).toBe('from home')
})
