import { evaluate, expect } from 'reeval'

// Run from deep/nested/, the config's file('marker.txt') is the project root's.
evaluate('lands', async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('marker.txt')).toBe('from the project root\n')
})
