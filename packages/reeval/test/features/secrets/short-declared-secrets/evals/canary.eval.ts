import { evaluate, expect } from 'reeval'
import { pins } from './env.ts'

// Must fail: PLACEHOLDER prints too.
evaluate('canary', { environments: pins }, async (c) => {
  await c.send('print PIN and PLACEHOLDER')
  expect((await c.exec('printf "%s\\n" "$PIN" "$PLACEHOLDER"')).stdout).toBe('1234\n')
})
