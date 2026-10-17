import { evaluate, expect } from 'reeval'
import { repo } from './env.ts'

// The workspace is a git repository: one commit of the fetched tree, clean, with no remote.
evaluate('lands', { environment: repo }, async (c) => {
  const r = await c.exec('git rev-list --count HEAD && git status --porcelain && git remote')
  expect(r.stdout).toBe('1\n')
})
