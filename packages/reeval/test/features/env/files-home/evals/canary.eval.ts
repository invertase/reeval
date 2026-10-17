import { evaluate, expect } from 'reeval'
import { homeFiles } from './env.ts'

// Must fail: a `~/` file isn't written into the workspace.
evaluate('canary', { environment: homeFiles }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('.config/reeval/hint.txt')).toBe('from home')
})
