import { evaluate, expect } from 'reeval'
import { mac } from './env.ts'

// Must fail: no VM started on full, which was at its VM limit.
evaluate('canary', { environments: mac }, async (c) => {
  const r = await c.exec('pwd')
  expect(r.stdout.trim()).toMatch(/\/hosts\/full\/vms\//)
})
