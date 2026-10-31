import { evaluate, expect } from 'reeval'
import { greeting } from './env.ts'

// Must fail: Cursor's directory isn't where the fake agent's workspace skills go.
evaluate('canary', { environments: greeting }, async (c) => {
  const dir = '.cursor/skills/house-greeting'
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md', './docs/tone.md'])
})
