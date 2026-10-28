import { evaluate, expect } from 'reeval'

evaluate('clamps a number', async (c) => {
  await c.send('Write src/clamp.js: clamp(n, lo, hi) keeps n between lo and hi.')
  expect(await c.readFile('src/clamp.js'), 'bounds with Math.min').toContain('Math.min(')
})
