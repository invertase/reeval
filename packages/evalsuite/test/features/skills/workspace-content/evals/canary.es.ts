import { evaluate, expect } from 'evalsuite'
import { greeting, staged } from './env.ts'

// Must fail: the source frontmatter's other keys aren't copied.
evaluate('canary', { environment: greeting }, async (t) => {
  await t.send('noop')
  expect(await t.readFile(staged)).toContain('license: MIT')
})
