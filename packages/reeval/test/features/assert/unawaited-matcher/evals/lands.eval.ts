import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// toHaveFile reads the sandbox, so it's async and awaited.
evaluate('lands', { environment: plain }, async (c) => {
  await c.send('write the marker')
  await expect(c, 'writes the marker').toHaveFile('marker.txt', /ok/)
})
