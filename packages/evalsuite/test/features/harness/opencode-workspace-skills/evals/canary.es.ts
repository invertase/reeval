import { evaluate, expect } from 'evalsuite'
import { greeting } from './env.ts'

// Must fail: OpenCode's workspace skills don't go to .agents/skills, which it reads only without
// OPENCODE_DISABLE_EXTERNAL_SKILLS.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.sandbox()
  const dir = '.agents/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
