import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  expect(await c.readFile('missing.txt')).toBe('present')
})
