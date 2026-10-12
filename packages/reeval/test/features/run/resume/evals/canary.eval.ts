import { evaluate, expect } from 'reeval'
import { resume } from './env.ts'

// Must fail: the leftover staging is the same run, not a new one with a different marker.
evaluate('canary', { environment: resume }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('marker.txt')).toBe('new-run')
})
