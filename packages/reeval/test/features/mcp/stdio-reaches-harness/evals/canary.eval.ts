import { evaluate, expect } from 'reeval'
import { LOG, stamp } from './env.ts'

// Must fail: with no turn, nothing has called the tool.
evaluate('canary', { environment: stamp }, async (t) => {
  await t.sandbox()
  expect((await t.readFile(LOG)) ?? '').toContain('tools/call')
})
