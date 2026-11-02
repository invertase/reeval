import { evaluate, expect } from 'reeval'
import { retry } from './env.ts'

evaluate('lands', { environments: retry }, async (c) => {
  await c.send('Say done.')
  expect(await c.readFile('marker.txt')).toBe('retry')
})
