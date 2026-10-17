import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Under pi, a workspace-placed skill lands in .pi/skills, which it reads in a trusted project.
evaluate('lands', { environment: greeting }, async (c) => {
  const dir = '.pi/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
