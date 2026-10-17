import { evaluate, expect } from 'reeval'
import { HOG, small } from './env.ts'

// The kernel kills the hog at docker({ memory }): the attempt is an infra error, not a failed check.
evaluate('builds the app', { environment: small }, async (c) => {
  await expect(c.exec(HOG)).toSucceed()
})
