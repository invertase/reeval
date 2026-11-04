import { evaluate, expect } from 'reeval'
import { mac } from './env.ts'

// full is busy, so the attempt moves to free instead of failing.
evaluate('lands', { environments: mac }, async (c) => {
  const r = await c.exec('pwd')
  expect(r.stdout.trim()).toMatch(/\/hosts\/free\/vms\//)
})
