import { evaluate, expect } from 'reeval'
import { greeting, staged } from './env.ts'

// Must fail: the source frontmatter's other keys aren't copied.
evaluate('canary', { environment: greeting }, async (c) => {
  await c.sandbox()
  expect(await c.readFile(staged)).toContain('license: MIT')
})
