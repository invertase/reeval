import { evaluate, expect } from 'evalsuite'
import { greeting, listStaged } from './env.ts'

// Must fail: a custom exclude doesn't add to the defaults, so evals/ isn't left out.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.send('noop')
  const files = (await t.exec(listStaged)).stdout.trim().split('\n')
  expect(files).not.toContain('./evals/prompts.md')
})
