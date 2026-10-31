import { evaluate, expect } from 'reeval'
import { plain, readWhenWritten } from './env.ts'

// Must fail: the file holds `started`, not `stopped`.
evaluate('canary', { environments: plain }, async (c) => {
  await c.exec('sleep 1 && echo started > bg.txt', { background: true })
  const r = await c.exec(readWhenWritten('bg.txt'))
  expect(r.stdout.trim()).toBe('stopped')
})
