import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: Claude Code's workspace skills don't go to .cursor/skills.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  const dir = '.cursor/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
