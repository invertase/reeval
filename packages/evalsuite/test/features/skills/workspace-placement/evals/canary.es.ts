import { evaluate, expect } from 'evalsuite'
import { greeting } from './env.ts'

// Must fail: Cursor's directory isn't where the fake agent's workspace skills go.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.send('noop')
  const dir = '.cursor/skills/house-greeting'
  const files = (await t.exec(`cd ${dir} && find . -type f | LC_ALL=C sort`)).stdout
  expect(files.trim().split('\n')).toEqual(['./SKILL.md', './docs/tone.md'])
})
