import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// A workspace-placed skill's directory lands in the agent's repo skill directory, whole.
evaluate('lands', { environment: greeting }, async (c) => {
  const dir = '.agents/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md', './docs/tone.md'])
})
