import { evaluate, expect } from 'reeval'
import { pinned, placed } from './env.ts'

// Must fail: only: ['skills', 'mcp'] leaves the plugin's hooks out.
evaluate('canary', { environments: pinned }, async (c) => {
  expect((await c.exec(`cat ${placed}/hooks/hooks.json`)).stdout).toContain('SessionStart')
})
