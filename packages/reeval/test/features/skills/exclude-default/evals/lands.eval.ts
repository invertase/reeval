import { evaluate, expect } from 'reeval'
import { greeting, listStaged } from './env.ts'

// With no exclude, a top-level evals/, .history/ and *.eval.ts stay out; a nested evals/ lands.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.sandbox()
  const files = (await t.exec(listStaged)).stdout.trim().split('\n')
  expect(files).toEqual(['./SKILL.md', './docs/evals/checklist.md', './docs/tone.md'])
})
