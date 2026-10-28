import { evaluate, expect } from 'reeval'

evaluate('greets by name', async (c) => {
  await c.send('Write src/greet.js: greet(name) returns "Hello, <name>!".')
  expect(await c.readFile('src/greet.js'), 'says hello').toContain('Hello, ')
})
