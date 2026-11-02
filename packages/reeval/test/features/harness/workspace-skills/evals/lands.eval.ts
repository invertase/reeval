import { evaluate, expect } from 'reeval'
import { skillDirs } from '../layout.ts'
import { greeting } from './env.ts'

// A workspace-placed skill lands in the repo skill directory the harness reads.
evaluate('lands', { environments: greeting }, async (c) => {
  const dir = `${skillDirs.lands}/house-greeting`
  const files = (await c.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md'])
})
