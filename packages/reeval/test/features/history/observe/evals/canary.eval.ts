import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { observeInstall } from './observe.ts'

evaluate('canary', { environment: plain }, async (c) => {
  const deps = await observeInstall(c)
  // The mistake: the agent installed drizzle-orm, not prisma.
  expect(deps, 'installs prisma').toHaveProperty('prisma')
})
