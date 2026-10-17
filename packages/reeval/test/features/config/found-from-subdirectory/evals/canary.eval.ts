import { evaluate, expect } from 'reeval'

// Must fail: file() never resolves from the current directory.
evaluate('canary', async (c) => {
  expect(await c.readFile('marker.txt')).toBe('from the current directory\n')
})
