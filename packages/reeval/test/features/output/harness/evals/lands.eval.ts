import { evaluate, expect } from 'reeval'
import { copier, writer } from './agents.ts'

// Compare harnesses: a row per harness with its `N of M`.
evaluate('lands', { harnesses: [writer, copier] }, async (c) => {
  await c.send('write out.txt')
  await expect(c, 'writes out.txt').toHaveFile('out.txt')
})
