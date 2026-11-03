import { evaluate, expect } from 'reeval'

evaluate('works in a macOS VM', async (c) => {
  await c.send('Say hello')
  const r = await c.exec('printf hello > hello.txt && cat hello.txt')
  expect(r.stdout).toBe('hello')
})
