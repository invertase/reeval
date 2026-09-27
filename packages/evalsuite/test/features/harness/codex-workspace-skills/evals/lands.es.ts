import { evaluate, expect } from 'evalsuite'
import { greeting } from './env.ts'

// Under Codex, a workspace-placed skill lands in .agents/skills, which it reads from the repo.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.agents/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
