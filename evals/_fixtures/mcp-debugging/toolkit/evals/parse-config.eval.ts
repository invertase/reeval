import { evaluate, expect } from 'reeval'

evaluate('parses the config', async (c) => {
  await c.send('Write src/parse-config.js: parseConfig(path) reads a JSON config file.')
  expect.soft(await c.readFile('src/parse-config.js'), 'parses JSON').toContain('JSON.parse(')
})
