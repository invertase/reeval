import { evaluate, expect } from 'reeval'
import { pinned, placed } from './env.ts'

// Must fail: only: ['skills', 'commands'] leaves the plugin's subagent out.
evaluate('canary', { environment: pinned }, async (c) => {
  expect((await c.exec(`cat ${placed}/agents/reviewer.md`)).stdout).toContain(
    'Review the diff for the house style.',
  )
})
