import { evaluate, expect } from 'reeval'

// Must fail: file() never resolves from the current directory.
evaluate('canary', async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('marker.txt')).toBe('from the current directory\n')
})
