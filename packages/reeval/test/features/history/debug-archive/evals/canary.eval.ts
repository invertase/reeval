import { evaluate, expect } from 'reeval'
import { archived } from './env.ts'

// The mistake: it looks for a file the environment never writes, so its attempt fails and keeps
// its files; its debug data is zipped all the same.
evaluate('canary', { environments: archived }, async (c) => {
  await c.send('look for the marker')
  await expect(c, 'has the marker').toHaveFile('missing.txt')
})
