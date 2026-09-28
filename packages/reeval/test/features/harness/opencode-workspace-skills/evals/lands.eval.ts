import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Under OpenCode, a workspace-placed skill lands in .opencode/skills, the repo skill directory it reads.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.opencode/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
