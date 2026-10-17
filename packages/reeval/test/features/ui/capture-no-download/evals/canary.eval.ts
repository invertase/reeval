import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  expect(await c.readFile('missing.txt')).toBe('present')
})
