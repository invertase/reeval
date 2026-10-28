import { evaluate, expect } from 'reeval'

evaluate('sums a list', async (c) => {
  await c.send('Write src/sum.js: sum(xs) adds up a list of numbers.')
  expect(await c.readFile('src/sum.js'), 'folds with reduce').toContain('reduce(')
})
