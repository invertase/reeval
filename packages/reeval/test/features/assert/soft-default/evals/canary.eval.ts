import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail on the throw: it's only reached when the failed expect before it carries on.
evaluate('canary', { environments: plain }, async (c) => {
  await c.send('write the marker')
  await expect(c, 'says nope').toHaveFile('marker.txt', /nope/)
  throw new Error('carried on past a failed expect')
})
