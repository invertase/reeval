import { evaluate, expect } from 'reeval'
import { placed, review } from './env.ts'

// Must fail: only leaves the plugin's commands out, so commands/review.md isn't placed.
evaluate('canary', { environments: review }, async (c) => {
  expect((await c.exec(`cat ${placed}/commands/review.md`)).stdout).toContain(
    'Review the working tree.',
  )
})
