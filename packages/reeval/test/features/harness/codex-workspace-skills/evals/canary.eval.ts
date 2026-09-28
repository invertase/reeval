import { evaluate, expect } from 'evalsuite'
import { greeting } from './env.ts'

// Must fail: Codex's workspace skills go to .agents/skills, not Claude Code's .claude/skills.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.claude/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
