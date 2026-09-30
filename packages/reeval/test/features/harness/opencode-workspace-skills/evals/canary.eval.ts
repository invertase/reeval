import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: reeval doesn't put OpenCode's workspace skills in .agents/skills, though OpenCode 2 reads
// that too.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  const dir = '.agents/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
