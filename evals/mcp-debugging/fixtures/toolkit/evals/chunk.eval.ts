import { evaluate, expect } from 'reeval'

evaluate('chunks an array', async (c) => {
  await c.send('Write src/chunk.js: chunk(xs, n) splits xs into arrays of n items.')
  expect(await c.readFile('src/chunk.js'), 'cuts with slice').toContain('slice(')
})
