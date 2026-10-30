import { evaluate, expect } from 'reeval'

evaluate('a read the harness never finished', async (c) => {
  await c.send('Uppercase beta in notes.txt')
  expect(await c.readFile('notes.txt')).toBe('BETA\n')
})
