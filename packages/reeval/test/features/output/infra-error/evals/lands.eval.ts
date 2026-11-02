import { evaluate } from 'reeval'
import { missing } from './env.ts'

// A setup step that can't start is an infra error: the tally counts it apart from the fails.
evaluate('lands', { environments: missing }, async (c) => {
  await c.exec('true')
})
