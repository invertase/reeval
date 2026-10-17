import { evaluate } from 'reeval'
import { missing } from './env.ts'

// A setup step whose cwd doesn't exist fails at once: the attempt is an infra error that says the
// step failed, not that it timed out (features.test.ts checks the message).
evaluate('lands', { environment: missing }, async (c) => {
  await c.exec('true')
  throw new Error('the eval body ran after a failed setup step')
})
