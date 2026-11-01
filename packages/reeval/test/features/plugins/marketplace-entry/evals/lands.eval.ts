import { evaluate, expect } from 'reeval'
import { listed, plugins } from './env.ts'

// plugin.marketplace places the entry it names, read from the marketplace's repository.
evaluate('lands', { environments: listed }, async (c) => {
  expect((await c.exec(`cat ${plugins}/review/agents/reviewer.md`)).stdout).toContain(
    'Review the diff for the house style.',
  )
})
