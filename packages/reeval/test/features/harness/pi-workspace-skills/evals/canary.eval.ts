import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: pi's workspace skills go to its own .pi/skills, not .agents/skills.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  const dir = '.agents/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
