import { evaluate, expect } from 'reeval'

evaluate('pads a string', async (c) => {
  await c.send('Write src/pad.js: pad(s, n) pads s on the left to n characters.')
  expect.soft(await c.readFile('src/pad.js'), 'pads with padStart').toContain('padStart(')
})
