import { evaluate, expect } from 'reeval'
import { notes } from './env.ts'

// First calls made at once share one start: what one wrote, the others' sandbox has.
evaluate('lands', { environment: notes }, async (c) => {
  await Promise.all([
    c.writeFile('marker.txt', 'written'),
    c.exec('test -f notes.txt'),
    c.readFile('notes.txt'),
  ])
  expect(await c.readFile('marker.txt')).toBe('written')
})
