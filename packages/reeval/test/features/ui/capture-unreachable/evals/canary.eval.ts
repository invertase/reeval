import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain, capture: { timeout: '2s' } }, async (c) => {
  await c.sandbox()
  try {
    await c.capture({ name: 'gone', path: '/', port: 59999 })
  } catch (error) {
    expect((error as Error).message).toBe('port is closed')
  }
})
