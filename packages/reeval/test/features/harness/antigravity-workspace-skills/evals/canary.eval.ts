import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: Antigravity's workspace skills don't go to Gemini CLI's .gemini/skills.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  const dir = '.gemini/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
