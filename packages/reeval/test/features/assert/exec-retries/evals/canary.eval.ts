import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { FLAKY } from './flaky.ts'

evaluate('canary', { environments: plain }, async (c) => {
  // The mistake: no retries, so the transient first try is the check's answer.
  await expect(c.exec(FLAKY), 'flaky passes').toSucceed()
})
