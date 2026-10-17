import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Under Claude Code, a workspace-placed skill lands in .claude/skills, the repo skill directory it reads.
evaluate('lands', { environment: greeting }, async (c) => {
  const dir = '.claude/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
