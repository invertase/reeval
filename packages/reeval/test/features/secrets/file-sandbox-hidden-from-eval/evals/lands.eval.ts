import { evaluate, expect } from 'reeval'
import { keys } from './env.ts'

// The eval code reads a sandbox-mode secret's placeholder, never its value.
evaluate('lands', { environments: keys }, async () => {
  expect(process.env.API_KEY).toMatch(/^reeval_secret_[0-9A-Za-z]{32}$/)
})
