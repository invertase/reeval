import { evaluate, expect } from 'reeval'
import { placed, unbuilt } from './env.ts'

// Must fail: this build writes nothing, so the built file is missing.
evaluate('canary', { environments: unbuilt }, async (c) => {
  expect((await c.exec(`cat ${placed}/dist/built.txt`)).stdout).toContain('built on linux as uid 0')
})
