import { evaluate, expect } from 'reeval'
import { repo } from './env.ts'

// Must fail: the source repository's history (two commits) isn't copied in, only its tree.
evaluate('canary', { environment: repo }, async (c) => {
  await c.sandbox()
  const r = await c.exec('git rev-list --count HEAD && git status --porcelain && git remote')
  expect(r.stdout).toBe('2\n')
})
