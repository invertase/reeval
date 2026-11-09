import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// Must fail: what the eval code reads is the placeholder.
evaluate('canary', { environments: keys }, async () => {
  expect(process.env.API_KEY?.startsWith('reeval_secret_')).toBe(false)
})
