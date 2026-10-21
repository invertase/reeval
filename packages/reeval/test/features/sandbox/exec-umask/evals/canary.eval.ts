import { evaluate, expect } from 'reeval'
import { unmasked, writable } from './env.ts'

// Must fail: the setup step runs `umask 0000` first, so out/ and out/log are world-writable.
evaluate('canary', { environment: unmasked }, async (c) => {
  await c.send('make things')
  expect(await writable(c)).toEqual([])
})
