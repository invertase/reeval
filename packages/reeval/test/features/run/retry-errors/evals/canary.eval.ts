import { evaluate, expect } from 'reeval'
import { retry } from './env.ts'

// Must fail: the retry runs the eval body again, so it reads the file rather than ending in the
// first run's infra error.
evaluate('canary', { environments: retry }, async (c) => {
  await c.send('Say done.')
  expect(await c.readFile('marker.txt')).toBe('errored')
})
