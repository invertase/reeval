import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

// Must fail: the marker holds what c.writeFile wrote, not the agent's notes.
evaluate('canary', { environments: notes }, async (c) => {
  await Promise.all([
    c.writeFile('marker.txt', 'written'),
    c.exec('test -f notes.txt'),
    c.readFile('notes.txt'),
  ])
  expect(await c.readFile('marker.txt')).toBe('from the agent\n')
})
