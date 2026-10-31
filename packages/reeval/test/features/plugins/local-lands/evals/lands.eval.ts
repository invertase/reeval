import { evaluate, expect } from 'reeval'
import { placed, review } from './env.ts'

// plugin.local copies the plugin's kept parts into the sandbox: its subagent is there.
evaluate('lands', { environments: review }, async (c) => {
  expect((await c.exec(`cat ${placed}/agents/reviewer.md`)).stdout).toContain(
    'Review the diff for the house style.',
  )
})
