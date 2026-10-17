import { evaluate, expect } from 'reeval'
import { greeting, listStaged } from './env.ts'

// Must fail: the skill's eval prompts are excluded by default.
evaluate('canary', { environment: greeting }, async (c) => {
  const files = (await c.exec(listStaged)).stdout.trim().split('\n')
  expect(files).toContain('./evals/prompts.md')
})
