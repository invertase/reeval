import { expect, survey } from 'reeval'

// A survey records the pick and gates nothing: its failed expect leaves it `ran`, not failed.
survey('lands', async (c) => {
  c.observe('pick', await c.readFile('pick.txt'))
  expect(await c.readFile('pick.txt'), 'picks postgres').toBe('postgres')
})
