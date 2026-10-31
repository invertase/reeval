import { evaluate } from 'reeval'
import { missing } from './env.ts'

// A workspace that can't be fetched fails its attempts as an infra error naming the ref
// (features.test.ts checks the message), and the eval body never runs.
evaluate('lands', { environments: missing }, async (c) => {
  await c.exec('true')
  throw new Error('the eval body ran without its workspace')
})
