import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Under Antigravity, a workspace-placed skill lands in .agents/skills, the repo skill directory it reads.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.agents/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
