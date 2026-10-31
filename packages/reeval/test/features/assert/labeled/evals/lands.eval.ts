import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// The label is data: the record keeps it with the matcher and its outcome.
evaluate('lands', { environments: plain }, async (c) => {
  await c.send('write the marker')
  await expect(c, 'writes the marker').toHaveFile('marker.txt', /ok/)
})
