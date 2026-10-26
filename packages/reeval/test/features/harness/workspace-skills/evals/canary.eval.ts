import { evaluate, expect } from 'reeval'
import { skillDirs } from '../layout.ts'
import { greeting } from './env.ts'

// Must fail: the skill lands in the harness's own skill directory only.
evaluate('canary', { environment: greeting }, async (c) => {
  const dir = `${skillDirs.not}/house-greeting`
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
