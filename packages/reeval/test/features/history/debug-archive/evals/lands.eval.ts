import { evaluate, expect } from 'reeval'
import { archived } from './env.ts'

evaluate('lands', { environments: archived }, async (c) => {
  await c.send('look for the marker')
  await expect(c, 'has the marker').toHaveFile('marker.txt')
})
