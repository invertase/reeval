import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Under Goose, a workspace-placed skill lands in .goose/skills, its own repo skill directory.
evaluate('lands', { environment: greeting }, async (c) => {
  const dir = '.goose/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
