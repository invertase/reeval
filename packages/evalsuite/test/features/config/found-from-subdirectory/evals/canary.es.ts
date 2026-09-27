import { evaluate, expect } from 'evalsuite'

// Must fail: file() never resolves from the current directory.
evaluate('canary', async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('marker.txt')).toBe('from the current directory\n')
})
