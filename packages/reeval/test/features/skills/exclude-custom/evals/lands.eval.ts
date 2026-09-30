import { evaluate, expect } from 'reeval'
import { greeting, listStaged } from './env.ts'

// A custom exclude replaces the defaults: its patterns stay out, and evals/ lands.
evaluate('lands', { environment: greeting }, async (c) => {
  await c.sandbox()
  const files = (await c.exec(listStaged)).stdout.trim().split('\n')
  expect(files).toEqual(['./SKILL.md', './docs/tone.md', './evals/prompts.md'])
})
