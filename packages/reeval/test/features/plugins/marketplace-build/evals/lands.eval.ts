import { evaluate, expect } from 'reeval'
import { built, placed } from './env.ts'

// The entry's build ran on the whole marketplace, and its output is placed with the plugin.
evaluate('lands', { environment: built }, async (c) => {
  expect((await c.exec(`cat ${placed}/dist/built.txt`)).stdout).toContain(
    'built from the acme-tools marketplace',
  )
})
