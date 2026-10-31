import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { observeInstall } from './observe.ts'

// The observations are data: the record keeps each name's last value and the turn it came after.
evaluate('lands', { environments: plain }, async (c) => {
  const deps = await observeInstall(c)
  expect(deps, 'installs drizzle').toHaveProperty('drizzle-orm')
})
