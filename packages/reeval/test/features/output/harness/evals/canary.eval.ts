import { evaluate, expect } from 'reeval'
import { idler, writer } from './agents.ts'

// Must fail: the idler writes nothing, so its row indents the failed check.
evaluate('canary', { harness: [writer, idler] }, async (c) => {
  await c.send('write out.txt')
  await expect(c, 'writes out.txt').toHaveFile('out.txt')
})
