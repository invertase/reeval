import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: Cursor's workspace skills don't go to .claude/skills.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  const dir = '.claude/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
