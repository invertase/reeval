import { evaluate, expect } from 'reeval'
import { KEY, plain } from './env.ts'

evaluate.each([{ key: KEY }])('canary [$key]', { environment: plain }, async (_c, { key }) => {
  // The mistake: only the name is masked, so the body gets the key itself, not [REDACTED].
  expect(key, 'gets the case masked').toBe('[REDACTED]')
})
