import { evaluate, expect } from 'evalsuite'

// Run from deep/nested/, the config's file('marker.txt') is the project root's.
evaluate('lands', async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('marker.txt')).toBe('from the project root\n')
})
