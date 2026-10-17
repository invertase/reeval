import { evaluate, expect } from 'reeval'
import { resume } from './env.ts'

evaluate('lands', { environment: resume }, async (c) => {
  expect(await c.readFile('marker.txt')).toBe('resume')
})
