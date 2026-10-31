import { evaluate, expect } from 'reeval'

// Must fail: the same body under evaluate gates on its expect.
evaluate('canary', async (c) => {
  c.observe('pick', await c.readFile('pick.txt'))
  expect(await c.readFile('pick.txt'), 'picks postgres').toBe('postgres')
})
