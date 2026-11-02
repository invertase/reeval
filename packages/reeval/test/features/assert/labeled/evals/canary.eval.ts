import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  await c.send('write the marker')
  // The mistake: the marker says ok, not nope.
  await expect(c, 'writes the marker').toHaveFile('marker.txt', /nope/)
})
