import { evaluate, expect } from 'reeval'
import { resume } from './env.ts'

evaluate('lands', { environment: resume }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('marker.txt')).toBe('resume')
})
