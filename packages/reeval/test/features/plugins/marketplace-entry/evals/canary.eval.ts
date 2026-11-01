import { evaluate, expect } from 'reeval'
import { listed, plugins } from './env.ts'

// Must fail: the marketplace's other entry, lint, isn't placed.
evaluate('canary', { environments: listed }, async (c) => {
  expect((await c.exec(`cat ${plugins}/lint/commands/lint.md`)).stdout).toContain(
    'Lint the tree for the house style.',
  )
})
