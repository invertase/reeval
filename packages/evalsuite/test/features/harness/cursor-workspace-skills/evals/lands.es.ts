import { evaluate, expect } from 'evalsuite'
import { greeting } from './env.ts'

// Under Cursor, a workspace-placed skill lands in .cursor/skills, the repo skill directory it reads.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.cursor/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
