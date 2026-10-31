import { evaluate, expect } from 'reeval'
import { greeting, listStaged } from './env.ts'

// Must fail: a custom exclude doesn't add to the defaults, so evals/ isn't left out.
evaluate('canary', { environments: greeting }, async (c) => {
  const files = (await c.exec(listStaged)).stdout.trim().split('\n')
  expect(files).not.toContain('./evals/prompts.md')
})
