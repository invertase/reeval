import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  await c.send('write the marker')
  // The mistake: no `await`, so the attempt fails naming the matcher and this line.
  expect(c, 'writes the marker').toHaveFile('marker.txt', /ok/)
})
