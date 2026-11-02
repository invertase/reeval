import { evaluate, expect } from 'reeval'
import { placed, review } from './env.ts'

// Must fail: only: ['skills'] leaves the plugin's subagent out.
evaluate('canary', { environments: review }, async (c) => {
  await c.send('Lint the change.')
  expect((await c.exec(`cat ${placed}/agents/reviewer.md`)).stdout).toContain(
    'Review the diff for the house style.',
  )
})
