import { evaluate, expect } from 'reeval'

evaluate('removes duplicates', async (c) => {
  await c.send('Write src/uniq.js: uniq(xs) drops repeated items, keeping the first.')
  expect.soft(await c.readFile('src/uniq.js'), 'dedupes with a Set').toContain('new Set(')
})
