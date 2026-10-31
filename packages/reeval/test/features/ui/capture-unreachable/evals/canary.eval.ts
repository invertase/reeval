import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain, capture: { timeout: '2s' } }, async (c) => {
  try {
    await c.capture(59999, { name: 'gone' })
  } catch (error) {
    expect((error as Error).message).toBe('port is closed')
  }
})
