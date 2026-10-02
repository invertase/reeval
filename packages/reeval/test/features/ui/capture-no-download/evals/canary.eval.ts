import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('missing.txt')).toBe('present')
})
