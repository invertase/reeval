import { evaluate } from 'evalsuite'
import { typo } from './env.ts'

// `only` naming a skill the source doesn't have is an infra error that names it and lists what
// the source has (features.test.ts checks the message); the eval body never runs.
evaluate('lands', { environment: typo }, async (t) => {
  await t.sandbox()
  throw new Error('the eval body ran with a skill missing from only')
})
