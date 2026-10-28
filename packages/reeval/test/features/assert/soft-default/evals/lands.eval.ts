import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Both failed expects are recorded and the body carries on to the gate; the failed
// `expect.require` ends it there, so `after the gate` never runs.
evaluate('lands', { environment: plain }, async (c) => {
  await c.send('write the marker')
  await expect(c, 'says nope').toHaveFile('marker.txt', /nope/)
  expect(c.attempt.n, 'is the second').toBe(2)
  await expect(c, 'writes the marker').toHaveFile('marker.txt', /ok/)
  await expect.require(c.exec('exit 3'), 'gate').toSucceed()
  expect(1, 'after the gate').toBe(1)
})
