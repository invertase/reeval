import { evaluate, expect } from 'reeval'
import { built, placed } from './env.ts'

// The build ran in the image layer, as root, and its output is placed with the plugin.
evaluate('lands', { environments: built }, async (c) => {
  expect((await c.exec(`cat ${placed}/dist/built.txt`)).stdout).toContain('built on linux as uid 0')
})
