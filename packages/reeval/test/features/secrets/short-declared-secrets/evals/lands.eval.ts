import { evaluate, expect } from 'reeval'
import { pins } from './env.ts'

// Checks see the values; the agent prints them too. The oracle then checks the record still
// reads, with its nulls and numbers (the 1234 lines the agent added) intact.
evaluate('lands', { environment: pins }, async (c) => {
  await c.send('print PIN and PLACEHOLDER')
  expect((await c.exec('printenv PIN PLACEHOLDER')).stdout).toBe('1234\nnull\n')
})
