import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// Must fail: it isn't built on Cursor's image, so the Cursor SDK isn't there.
evaluate('canary', { environments: plain }, async (c) => {
  const found = await c.exec(
    'ls -d "$HOME"/.ai-sdk-harness/.harness-bootstrap/cursor-sdk/node_modules/@cursor/sdk 2>/dev/null',
  )
  expect(found.stdout.trim()).toMatch(/\/@cursor\/sdk$/)
})
