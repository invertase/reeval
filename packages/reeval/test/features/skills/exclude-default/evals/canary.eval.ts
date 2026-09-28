import { evaluate, expect } from 'reeval'
import { greeting, listStaged } from './env.ts'

// Must fail: the skill's eval prompts are excluded by default.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.sandbox()
  const files = (await t.exec(listStaged)).stdout.trim().split('\n')
  expect(files).toContain('./evals/prompts.md')
})
