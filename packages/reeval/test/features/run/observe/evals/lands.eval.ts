import { evaluate, expect } from 'reeval'

// gate: 'observe' records the pick and gates nothing: its failed expect leaves it `ran`, not failed.
evaluate('lands', { gate: 'observe' }, async (c) => {
  c.observe('pick', await c.readFile('pick.txt'))
  expect(await c.readFile('pick.txt'), 'picks postgres').toBe('postgres')
})
